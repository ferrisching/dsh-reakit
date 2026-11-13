import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { buildMcpConfig, REA_NODE_RANGE, REA_VERSION } from '../lib/config.js'
import { NODE_VERSION, ENGINE_LOCK_SHA256 } from '../lib/bootstrap.js'
import { checkRuntimeUpdates, selectCompatibleNode, nodeArchive, validateDependencyLock, prepareRuntimeCandidate, inspectManagedRuntime } from '../lib/runtime-versions.js'

const REA = '6.10.0', NODE = '26.13.0', RANGE = '>=24.22.1'
const INTEGRITY = `sha512-${createHash('sha512').update('rea fixture').digest('base64')}`
const ARCHIVE = Buffer.from('verified Node archive fixture')
const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE).digest('hex')
const candidate = () => ({
  rea: { version: REA, nodeRange: RANGE, tarball: `https://registry.npmjs.org/rea-agents/-/rea-agents-${REA}.tgz`, integrity: INTEGRITY, source: `https://www.npmjs.com/package/rea-agents/v/${REA}` },
  node: { version: NODE, lts: 'Krypton', source: `https://nodejs.org/dist/v${NODE}/`, archive: nodeArchive(NODE, ARCHIVE_SHA256, process.platform, process.arch) },
  platform: process.platform, arch: process.arch,
})
const lock = () => JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: { 'rea-agents': REA } },
  'node_modules/rea-agents': { version: REA, resolved: `https://registry.npmjs.org/rea-agents/-/rea-agents-${REA}.tgz`, integrity: INTEGRITY },
  'node_modules/example': { version: '1.2.3', resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz', integrity: `sha512-${createHash('sha512').update('dependency').digest('base64')}` },
} })

async function workspace(t) {
  const prefix = join(tmpdir(), 'dsh-reakit-version-test-'), base = await mkdtemp(prefix)
  t.after(async () => { assert.ok(resolve(base).startsWith(resolve(prefix))); await rm(base, { recursive: true, force: true }) })
  return { base, root: join(base, 'runtime') }
}

function metadataFetch({ latest = REA, checksumLines, deprecated } = {}) {
  const calls = []
  const nodes = [
    { version: `v${NODE}`, lts: 'Krypton', files: ['osx-arm64-tar', 'osx-x64-tar', 'linux-arm64', 'linux-x64', 'win-arm64-zip', 'win-x64-zip'] },
    { version: 'v24.22.1', lts: 'Krypton', files: ['osx-arm64-tar'] },
    { version: 'v99.0.0-beta.1', lts: false, files: ['osx-arm64-tar'] },
  ]
  return { calls, fetch: async (url, options) => {
    calls.push({ url, options })
    if (url === 'https://registry.npmjs.org/rea-agents') return new Response(JSON.stringify({ 'dist-tags': { latest }, versions: { [latest]: { name: 'rea-agents', version: latest, engines: { node: RANGE }, deprecated, dist: { tarball: `https://registry.npmjs.org/rea-agents/-/rea-agents-${latest}.tgz`, integrity: INTEGRITY } } } }))
    if (url === 'https://nodejs.org/dist/index.json') return new Response(JSON.stringify(nodes))
    if (url === `https://nodejs.org/dist/v${NODE}/SHASUMS256.txt`) return new Response(checksumLines ?? `${ARCHIVE_SHA256}  node-v${NODE}-${process.platform}-${process.arch}.tar.gz\n`)
    throw new Error(`Unexpected fetch: ${url}`)
  } }
}

test('fixed 6.9.0 / Node baseline and lock remain unchanged', () => {
  assert.equal(REA_VERSION, '6.9.0')
  assert.equal(NODE_VERSION, '24.22.1')
  assert.equal(REA_NODE_RANGE, '^22.23.4 || ^24.22.1 || >=26.12.1')
  assert.match(ENGINE_LOCK_SHA256, /^007050bed186/)
})

test('Node selection filters stable compatible LTS releases and platform artifacts', () => {
  const nodes = [{ version: 'v26.13.0', lts: 'Krypton', files: ['linux-x64'] }, { version: 'v26.12.1', lts: 'Krypton', files: ['linux-x64'] }, { version: 'v27.0.0', lts: false, files: ['linux-x64'] }]
  assert.equal(selectCompatibleNode(RANGE, nodes, 'linux', 'x64').version, 'v26.13.0')
  assert.equal(selectCompatibleNode('>=99.0.0', nodes, 'linux', 'x64'), undefined)
  assert.throws(() => nodeArchive('27.0.0-beta.1', '0'.repeat(64), 'linux', 'x64'), /Invalid Node/)
})

test('update check reads only official metadata and returns a compatible pair', async () => {
  const f = metadataFetch()
  const result = await checkRuntimeUpdates({ currentReaVersion: '6.9.0', currentNodeVersion: 'v24.22.1', currentReaNodeRange: REA_NODE_RANGE, platform: process.platform, arch: process.arch, fetchImpl: f.fetch })
  assert.equal(result.candidate.rea.version, REA)
  assert.equal(result.candidate.node.version, NODE)
  assert.equal(result.reaUpdateAvailable, true)
  assert.equal(result.nodeUpdateAvailable, true)
  assert.equal(f.calls.length, 3)
  assert.ok(f.calls.every(call => call.options.redirect === 'error'))
})

test('metadata rejects duplicate checksum entries, prerelease and deprecated candidates', async () => {
  const duplicate = metadataFetch({ checksumLines: `${ARCHIVE_SHA256}  node-v${NODE}-${process.platform}-${process.arch}.tar.gz\n${ARCHIVE_SHA256}  node-v${NODE}-${process.platform}-${process.arch}.tar.gz\n` })
  await assert.rejects(checkRuntimeUpdates({ currentReaVersion: '6.9.0', currentNodeVersion: 'v24.22.1', platform: process.platform, arch: process.arch, fetchImpl: duplicate.fetch }), /exactly one/)
  const beta = metadataFetch({ latest: '7.0.0-beta.1' })
  await assert.rejects(checkRuntimeUpdates({ currentReaVersion: '6.9.0', currentNodeVersion: 'v24.22.1', platform: process.platform, arch: process.arch, fetchImpl: beta.fetch }), /no usable stable/)
  const deprecated = metadataFetch({ deprecated: 'do not use' })
  const result = await checkRuntimeUpdates({ currentReaVersion: '6.9.0', currentNodeVersion: 'v24.22.1', platform: process.platform, arch: process.arch, fetchImpl: deprecated.fetch })
  assert.equal(result.candidate.rea.deprecated, 'do not use')
  await assert.rejects(prepareRuntimeCandidate(result.candidate, { runtimeDir: '/tmp/unused' }), /deprecated/)
})

test('complete dependency lock requires official integrity for every package', () => {
  assert.equal(validateDependencyLock(lock(), candidate().rea).packages['node_modules/example'].version, '1.2.3')
  for (const mutate of [
    value => { delete value.packages['node_modules/example'].integrity },
    value => { value.packages['node_modules/example'].resolved = 'https://evil.invalid/example.tgz' },
    value => { value.packages['node_modules/example'].link = true },
    value => { value.packages['node_modules/rea-agents'].integrity = 'sha512-wrong' },
    value => { value.packages['node_modules/example'].resolved = 'file:/tmp/example.tgz' },
  ]) {
    const value = JSON.parse(lock()); mutate(value)
    assert.throws(() => validateDependencyLock(JSON.stringify(value), candidate().rea))
  }
})

function installFixture(candidate, calls, failAt) {
  return async (command, args, options) => {
    calls.push({ command, args, options })
    if (command.endsWith('/tar')) {
      const nodePath = join(args[3], candidate.node.archive.directory, ...(candidate.platform === 'win32' ? ['node.exe'] : ['bin', 'node']))
      await mkdir(dirname(nodePath), { recursive: true })
      await writeFile(nodePath, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`v${candidate.node.version}\n`)})\n`, { mode: 0o755 })
      return { stdout: '', stderr: '' }
    }
    if (failAt === 'lock' && args[1] === 'install') throw new Error('lock generation failed')
    if (args[1] === 'install') {
      await writeFile(join(options.cwd, 'package-lock.json'), lock())
      return { stdout: '', stderr: '' }
    }
    if (failAt === 'ci' && args[1] === 'ci') throw new Error('ci failed')
    if (args[1] === 'ci') {
      const root = join(options.cwd, 'node_modules', 'rea-agents')
      await mkdir(join(root, 'scripts'), { recursive: true })
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'rea-agents', version: REA, engines: { node: RANGE } }))
      await writeFile(join(root, 'scripts', 'rea.mjs'), 'throw new Error("REA entry must not execute during preflight")\n')
      return { stdout: '', stderr: '' }
    }
    throw new Error(`Unexpected process: ${command} ${args.join(' ')}`)
  }
}

test('candidate preparation stages, verifies and atomically publishes a reusable runtime', async t => {
  const { root } = await workspace(t), value = candidate(), calls = []
  const result = await prepareRuntimeCandidate(value, { runtimeDir: root }, { fetchImpl: async () => new Response(ARCHIVE), run: installFixture(value, calls) })
  assert.equal(result.reaVersion, REA)
  assert.equal(result.nodeVersion, `v${NODE}`)
  assert.ok(calls.every(call => call.command !== value.rea.tarball))
  for (const call of calls.filter(call => call.args[1] === 'install' || call.args[1] === 'ci')) {
    assert.ok(call.args.includes('--ignore-scripts'))
    assert.ok(call.args.includes('--include=optional'))
    assert.ok(call.args.includes('--no-audit'))
  }
  const nodeMarker = JSON.parse(await readFile(join(result.directory, 'ready.json'), 'utf8'))
  const engineMarker = JSON.parse(await readFile(join(result.engineDirectory, 'ready.json'), 'utf8'))
  assert.equal(nodeMarker.formatVersion, 1)
  assert.equal(engineMarker.formatVersion, 1)
  const ready = { ...nodeMarker, ...engineMarker }
  assert.equal(ready.reaIntegrity, INTEGRITY)
  assert.equal(ready.archiveSha256, ARCHIVE_SHA256)
  assert.equal(ready.platform, process.platform)
  assert.equal(ready.arch, process.arch)
  const active = await inspectManagedRuntime({ runtimeDir: root, nodePath: result.config.command, reaEntry: result.config.args[0], managedReaVersion: REA, managedNodeRange: RANGE })
  assert.equal(await realpath(active.directory), await realpath(result.directory))
  await assert.rejects(readFile(join(root, '.setup.lock')), { code: 'ENOENT' })
})

test('failed dependency installation never replaces the previous generation', async t => {
  const { root } = await workspace(t), value = candidate(), oldFile = join(root, 'old-generation', 'ready.json')
  await mkdir(dirname(oldFile), { recursive: true }); await writeFile(oldFile, 'previous runtime bytes')
  await assert.rejects(prepareRuntimeCandidate(value, { runtimeDir: root }, { fetchImpl: async () => new Response(ARCHIVE), run: installFixture(value, [], 'ci') }), /ci failed/)
  assert.equal(await readFile(oldFile, 'utf8'), 'previous runtime bytes')
  const names = await readdir(root)
  assert.equal(names.some(name => name.startsWith(`node-${NODE}-rea-${REA}-`)), false)
})

test('dynamic activation rejects tampered ready metadata instead of downloading or falling back', async t => {
  const { root } = await workspace(t), value = candidate()
  const result = await prepareRuntimeCandidate(value, { runtimeDir: root }, { fetchImpl: async () => new Response(ARCHIVE), run: installFixture(value, []) })
  const settings = { runtimeDir: root, nodePath: result.config.command, reaEntry: result.config.args[0], managedReaVersion: REA, managedNodeRange: RANGE }
  const readyPath = join(result.directory, 'ready.json'), ready = JSON.parse(await readFile(readyPath, 'utf8'))
  ready.platform = 'other-platform'
  await writeFile(readyPath, JSON.stringify(ready))
  await assert.rejects(inspectManagedRuntime(settings), /ready marker|another platform/)
  ready.platform = process.platform
  await writeFile(readyPath, JSON.stringify(ready))
  await writeFile(result.config.args[0], 'tampered entry')
  await assert.rejects(inspectManagedRuntime(settings), /entry digest changed/)
})

test('preparation validates root, timeout and archive integrity before any publication', async t => {
  const { root } = await workspace(t), value = candidate()
  await assert.rejects(prepareRuntimeCandidate(value, { runtimeDir: 'relative' }), /absolute/)
  await assert.rejects(prepareRuntimeCandidate(value, { runtimeDir: root, setupTimeoutMs: 0 }), /setupTimeoutMs/)
  await mkdir(root, { mode: 0o755 }); await chmodForTest(root)
  const alias = join(dirname(root), 'alias')
  await symlink(root, alias, 'dir')
  await assert.rejects(prepareRuntimeCandidate(value, { runtimeDir: alias }), /not private/)
  const bad = candidate(); bad.node.archive.sha256 = '0'.repeat(64)
  await assert.rejects(prepareRuntimeCandidate(bad, { runtimeDir: join(root, 'new') }, { fetchImpl: async () => new Response(ARCHIVE), run: installFixture(bad, []) }), /SHA-256 mismatch/)
})

async function chmodForTest(root) {
  if (process.platform !== 'win32') {
    const { chmod } = await import('node:fs/promises')
    await chmod(root, 0o700)
  }
}

test('MCP config still validates dynamic launch paths without executing REA', () => {
  const config = buildMcpConfig({ nodePath: '/runtime/node', reaEntry: '/runtime/engine/node_modules/rea-agents/scripts/rea.mjs', managedReaVersion: REA, managedNodeRange: RANGE })
  assert.equal(config.command, '/runtime/node')
  assert.equal(config.args[1], 'mcp')
  assert.equal(config.env.REA_MCP_OUTPUT_SCHEMA_PROFILE, 'off')
})

test('split directory derivation matches the published layout', async () => {
  const { splitDirectories } = await import('../lib/runtime-versions.js')
  const root = '/r/runtime'
  const paths = splitDirectories(
    `${root}/node/darwin-arm64-26.13.0-d38bd5e5a2dd/bin/node`,
    `${root}/engine/rea6.9.0-8dc59ed24940/node_modules/rea-agents/scripts/rea.mjs`,
  )
  assert.equal(paths.nodeDirectory, `${root}/node/darwin-arm64-26.13.0-d38bd5e5a2dd`)
  assert.equal(paths.engineDirectory, `${root}/engine/rea6.9.0-8dc59ed24940`)
})
