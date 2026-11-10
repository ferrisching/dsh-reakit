import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectExistingRea, inspectExistingRea, verifyAdoption, candidateRoots, detectNodes, requiredNodeRange, profilesUsingManagedRuntime, currentProfileContext } from '../lib/existing-rea.js'

/** Build a fake global install: <root>/rea-agents/{package.json,scripts/rea.mjs}. */
async function install({ root, version = '6.8.0', range = '^22.23.4 || ^24.22.1 || >=26.12.1', entry = true, name = 'rea-agents' }) {
  const dir = join(root, 'rea-agents')
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, engines: { node: range } }))
  if (entry) await writeFile(join(dir, 'scripts', 'rea.mjs'), 'export {}\n')
  return { dir, entry: join(dir, 'scripts', 'rea.mjs') }
}

test('a global install is detected and reported usable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  const { entry } = await install({ root: base })
  const detected = await detectExistingRea({ roots: [base], nodeVersion: 'v26.13.0' })
  assert.equal(detected.candidates.length, 1)
  const candidate = detected.candidates[0]
  assert.equal(candidate.reaVersion, '6.8.0')
  assert.equal(candidate.entry, entry)
  assert.equal(candidate.usable, true)
  assert.equal(candidate.reason, '')
})

test('an incompatible Node or a missing entry is reported as a reason, not as ready', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  await install({ root: join(base, 'old'), range: '^18.0.0' })
  await install({ root: join(base, 'broken'), entry: false })
  const detected = await detectExistingRea({ roots: [join(base, 'old'), join(base, 'broken')], nodeVersion: 'v26.13.0' })
  assert.equal(detected.candidates.length, 2)
  const [first, second] = detected.candidates
  assert.equal(first.usable, false)
  assert.match(first.reason, /does not satisfy/)
  assert.equal(second.usable, false)
  assert.match(second.reason, /missing scripts\/rea\.mjs/)
  // usable entries sort first, so an unusable pair keeps its scan order
  assert.equal(detected.candidates.every(candidate => !candidate.usable), true)
})

test('directories that are not a rea-agents package are ignored', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  await install({ root: base, name: 'some-other-tool' })
  await mkdir(join(base, 'empty'), { recursive: true })
  const detected = await detectExistingRea({ roots: [base, join(base, 'empty')], nodeVersion: 'v26.13.0' })
  assert.deepEqual(detected.candidates, [])
})

test('a valid install sorts before an unusable one', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  await install({ root: join(base, 'a'), version: '6.5.0', range: '^18.0.0' })
  await install({ root: join(base, 'b'), version: '6.8.0' })
  const detected = await detectExistingRea({ roots: [join(base, 'a'), join(base, 'b')], nodeVersion: 'v26.13.0' })
  assert.equal(detected.candidates[0].usable, true)
  assert.equal(detected.candidates[0].reaVersion, '6.8.0')
  assert.equal(detected.candidates[1].usable, false)
})

test('candidate roots are deterministic and bounded', async () => {
  const roots = await candidateRoots({ env: { NODE_PATH: '/custom/node_modules' }, nodePath: '/opt/node/bin/node', home: '/home/user' })
  assert.ok(roots.includes('/custom/node_modules'))
  assert.ok(roots.includes(join('/opt/node', 'lib', 'node_modules')))
  assert.ok(roots.length <= 16)
  assert.equal(new Set(roots).size, roots.length)
})

test('adoption re-validates the exact entry and refuses anything else', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  const { dir, entry } = await install({ root: base })
  const adopted = await verifyAdoption({ nodePath: process.execPath, reaEntry: entry, nodeVersion: 'v26.13.0' })
  assert.equal(adopted.reaVersion, '6.8.0')
  await assert.rejects(verifyAdoption({ nodePath: process.execPath, reaEntry: join(dir, 'package.json'), nodeVersion: 'v26.13.0' }), /scripts\/rea\.mjs/)
  await assert.rejects(verifyAdoption({ nodePath: process.execPath, reaEntry: join(base, 'missing.mjs'), nodeVersion: 'v26.13.0' }), /does not exist/)
  await assert.rejects(verifyAdoption({ nodePath: '', reaEntry: entry, nodeVersion: 'v26.13.0' }), /Both nodePath and reaEntry/)
})

test('adoption refuses an install whose Node contract the host cannot satisfy', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  const { entry } = await install({ root: base, range: '^18.0.0' })
  await assert.rejects(verifyAdoption({ nodePath: process.execPath, reaEntry: entry, nodeVersion: 'v26.13.0' }), /does not satisfy/)
})

test('inspectExistingRea returns null for unreadable metadata', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  await mkdir(join(base, 'rea-agents'), { recursive: true })
  await writeFile(join(base, 'rea-agents', 'package.json'), 'not json')
  assert.equal(await inspectExistingRea({ root: base, nodePath: process.execPath, nodeVersion: 'v26.13.0' }), null)
})

test('node detection reads real versions and dedupes the same binary', async () => {
  const nodes = await detectNodes({ nodePath: process.execPath, env: { PATH: '' }, home: '/nonexistent-home' })
  assert.ok(nodes.length >= 1)
  assert.equal(nodes[0].nodePath, process.execPath)
  assert.match(nodes[0].nodeVersion, /^v\d+\.\d+\.\d+/)
  assert.equal(new Set(nodes.map(node => node.nodePath)).size, nodes.length)
})

test('the managed Node is offered first and the declared range is read from the package', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  const { entry } = await install({ root: base, range: '>=20.0.0' })
  const { range, reaVersion } = await requiredNodeRange(entry)
  assert.equal(range, '>=20.0.0')
  assert.equal(reaVersion, '6.8.0')
  const managed = { nodePath: '/managed/runtime/bin/node', nodeVersion: 'v99.0.0' }
  const nodes = await detectNodes({ nodePath: process.execPath, env: { PATH: '' }, home: '/nonexistent-home', managed })
  assert.equal(nodes[0].nodePath, managed.nodePath)
  assert.equal(nodes[0].nodeVersion, 'v99.0.0')
})

test('a range the managed Node cannot satisfy is still reported honestly', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-existing-'))
  const { entry } = await install({ root: base, range: '^18.0.0' })
  const { range } = await requiredNodeRange(entry)
  assert.equal(range, '^18.0.0')
  await assert.rejects(verifyAdoption({ nodePath: process.execPath, reaEntry: entry, nodeVersion: 'v26.13.0' }), /does not satisfy/)
})

test('profiles that still rely on the shared runtime block deletion', async () => {
  const profiles = await mkdtemp(join(tmpdir(), 'reakit-profiles-'))
  const make = async (name, patch) => {
    await mkdir(join(profiles, name, 'node_modules', 'dsh-reakit'), { recursive: true })
    if (patch !== null) await writeFile(join(profiles, name, 'cordis.patch.yml'), patch)
  }
  await make('current', 'plugins:\n- name: dsh-reakit\n  config:\n    nodePath: /own/node\n')
  await make('managed', 'plugins:\n- name: dsh-reakit\n  config:\n    enabled: true\n')
  await make('unreadable', null)
  await make('unrelated', 'plugins:\n- name: other\n')
  const blockers = await profilesUsingManagedRuntime({ profilesRoot: profiles, currentProfile: 'current' })
  assert.deepEqual(blockers.map(item => item.profile).sort(), ['managed', 'unreadable'])
  assert.equal(blockers.find(item => item.profile === 'unreadable').reason, 'configuration is unreadable')
  assert.equal(await profilesUsingManagedRuntime({ profilesRoot: join(profiles, 'missing'), currentProfile: 'current' }).then(list => list.length), 0)
})

test('the current profile is derived only from a real profiles directory', () => {
  assert.deepEqual(currentProfileContext('/home/u/.dsh/profiles/desktop'), { profilesRoot: '/home/u/.dsh/profiles', currentProfile: 'desktop' })
  assert.deepEqual(currentProfileContext('/srv/app'), { profilesRoot: null, currentProfile: null })
})

test('installers are detected without running them', async () => {
  const { detectNodeInstallers } = await import('../lib/node-install.js')
  const darwin = await detectNodeInstallers({ platform: 'darwin', env: { PATH: '/nonexistent-bin' }, home: '/nonexistent-home' })
  assert.ok(Array.isArray(darwin), 'darwin detection returns a list')
  for (const installer of darwin) assert.match(installer.command, /node/i)
  const linux = await detectNodeInstallers({ platform: 'linux', env: { PATH: '' }, home: '/nonexistent-home' })
  assert.deepEqual(linux, [])
  const win = await detectNodeInstallers({ platform: 'win32', env: { PATH: '' }, home: '/nonexistent-home' })
  assert.deepEqual(win, [])
})
