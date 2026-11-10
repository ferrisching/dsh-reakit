import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { splitLegacyGeneration, readSplitRuntime, splitPaths, planSplitRuntime, applySplitRuntime } from '../lib/runtime-split.js'

const sha256 = v => createHash('sha256').update(v).digest('hex')

async function legacyGeneration(root, { nodeVersion = '26.13.0', reaVersion = '6.8.0', lock = 'a'.repeat(64) } = {}) {
  const dir = join(root, `node-${nodeVersion}-rea-${reaVersion}-darwin-arm64-${lock.slice(0, 12)}`)
  const nodeDir = join(dir, `node-v${nodeVersion}-darwin-arm64`)
  await mkdir(join(nodeDir, 'bin'), { recursive: true })
  await writeFile(join(nodeDir, 'bin', 'node'), `#!/bin/sh\necho v${nodeVersion}\n`)
  await mkdir(join(dir, 'engine', 'node_modules', 'rea-agents', 'scripts'), { recursive: true })
  await writeFile(join(dir, 'engine', 'node_modules', 'rea-agents', 'package.json'), JSON.stringify({ name: 'rea-agents', version: reaVersion }))
  await writeFile(join(dir, 'engine', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'), 'export {}\n')
  await writeFile(join(dir, 'ready.json'), JSON.stringify({ formatVersion: 3, reaVersion, nodeVersion, nodeRange: '>=20', lockSha256: lock, nodeArchiveSha256: 'b'.repeat(64) }))
  return dir
}

const fakeRun = async binary => ({ stdout: `${(await readFile(binary, 'utf8')).match(/v[\d.]+/)[0]}\n` })

test('a legacy generation is split, verified and then removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-split-'))
  const generation = await legacyGeneration(root)
  const result = await splitLegacyGeneration({ root, generation, platform: 'darwin', arch: 'arm64', run: fakeRun })
  assert.equal(result.freedFromLegacy, true)
  await assert.rejects(stat(generation), /ENOENT/, 'legacy generation is gone')
  const ready = await readSplitRuntime(result.paths, { nodeVersion: '26.13.0', reaVersion: '6.8.0' })
  assert.ok(ready, 'split runtime verifies')
  assert.equal((await readdir(join(root, 'node'))).length, 1)
  assert.equal((await readdir(join(root, 'engine'))).length, 1)
  await rm(root, { recursive: true, force: true })
})

test('a failed verification keeps the legacy generation intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-split-'))
  const generation = await legacyGeneration(root)
  await assert.rejects(
    splitLegacyGeneration({ root, generation, platform: 'darwin', arch: 'arm64', run: async () => ({ stdout: 'v22.0.0\n' }) }),
    /Staged Node reports/,
  )
  await assert.doesNotReject(stat(generation), 'legacy generation survives')
  const leftovers = (await readdir(root)).filter(name => name.startsWith('.setup-split-'))
  assert.deepEqual(leftovers, [], 'staging is cleaned up')
  await rm(root, { recursive: true, force: true })
})

test('an existing split target is never overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-split-'))
  const generation = await legacyGeneration(root)
  const first = await splitLegacyGeneration({ root, generation, platform: 'darwin', arch: 'arm64', run: fakeRun })
  await mkdir(join(root, 'node', first.paths.nodeId), { recursive: true })
  const again = await legacyGeneration(root)
  await assert.rejects(splitLegacyGeneration({ root, generation: again, platform: 'darwin', arch: 'arm64', run: fakeRun }), /already exists/)
  await rm(root, { recursive: true, force: true })
})

test('split paths keep node and engine separate', () => {
  const paths = splitPaths('/r', { platform: 'darwin', arch: 'arm64', nodeVersion: '26.13.0', archiveSha256: 'c'.repeat(64), reaVersion: '6.8.0', lockSha256: 'd'.repeat(64) })
  assert.match(paths.nodeDirectory, /\/r\/node\//)
  assert.match(paths.engineDirectory, /\/r\/engine\//)
  assert.match(paths.nodePath, /\/bin\/node$/)
  assert.match(paths.reaEntry, /rea-agents\/scripts\/rea\.mjs$/)
})

test('the dry run maps legacy generations without touching anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-plan-'))
  const generation = await legacyGeneration(root)
  const before = (await readdir(root)).sort()
  const plan = await planSplitRuntime({ root, platform: 'darwin', arch: 'arm64' })
  assert.equal(plan.legacy, 1)
  assert.equal(plan.mapped.length, 1)
  const [entry] = plan.mapped
  assert.equal(entry.planable, true)
  assert.match(entry.nodeDirectory, /\/node\/darwin-arm64-26\.13\.0-/)
  assert.match(entry.engineDirectory, /\/engine\/rea6\.8\.0-/)
  assert.ok(entry.nodePath.endsWith('/bin/node'))
  assert.ok(entry.reaEntry.endsWith('rea-agents/scripts/rea.mjs'))
  assert.deepEqual(entry.conflicts, [])
  assert.deepEqual((await readdir(root)).sort(), before, 'nothing was created')
  await assert.doesNotReject(stat(generation), 'the legacy generation is untouched')
  await rm(root, { recursive: true, force: true })
})

test('the dry run reports conflicts and unusable markers instead of guessing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-plan-'))
  const generation = await legacyGeneration(root)
  const plan = await planSplitRuntime({ root, platform: 'darwin', arch: 'arm64' })
  await mkdir(plan.mapped[0].nodeDirectory, { recursive: true })
  const conflicted = await planSplitRuntime({ root, platform: 'darwin', arch: 'arm64' })
  assert.equal(conflicted.mapped[0].planable, false)
  assert.deepEqual(conflicted.mapped[0].conflicts, ['node target exists'])
  await writeFile(join(generation, 'ready.json'), JSON.stringify({ formatVersion: 3 }))
  const broken = await planSplitRuntime({ root, platform: 'darwin', arch: 'arm64' })
  assert.equal(broken.mapped[0].planable, false)
  assert.ok(broken.mapped[0].reasons.length > 0)
  await rm(root, { recursive: true, force: true })
})

test('generations sharing one REA lock are reported as sharing an engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-plan-'))
  await legacyGeneration(root, { nodeVersion: '24.22.1' })
  await legacyGeneration(root, { nodeVersion: '26.13.0' })
  const plan = await planSplitRuntime({ root, platform: 'darwin', arch: 'arm64' })
  assert.equal(plan.legacy, 2)
  assert.equal(plan.uniqueEngines, 1)
  assert.equal(plan.uniqueNodes, 2)
  const shared = plan.mapped.filter(entry => entry.sharedEngineWith)
  assert.equal(shared.length, 1, 'the second generation points at the first engine')
  await rm(root, { recursive: true, force: true })
})

test('applying the split publishes engine once and keeps every legacy generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-apply-'))
  const older = await legacyGeneration(root, { nodeVersion: '24.22.1' })
  const newer = await legacyGeneration(root, { nodeVersion: '26.13.0' })
  const run = async binary => ({ stdout: `${(await readFile(binary, 'utf8')).match(/v[\d.]+/)[0]}\n` })
  const report = await applySplitRuntime({ root, platform: 'darwin', arch: 'arm64', run })
  assert.equal(report.ok, true)
  assert.equal(report.uniqueEngines, 1, 'one engine for two generations')
  assert.equal(report.created.engines.length, 1)
  assert.equal(report.created.nodes.length, 2)
  assert.equal(report.legacyPreserved, true)
  assert.equal(report.configUntouched, true)
  assert.equal(report.verified.length, 2)
  await assert.doesNotReject(stat(older), 'the older legacy generation is kept')
  await assert.doesNotReject(stat(newer), 'the newer legacy generation is kept')
  await rm(root, { recursive: true, force: true })
})

test('a second apply reuses what already exists instead of failing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-apply-'))
  await legacyGeneration(root, { nodeVersion: '26.13.0' })
  const run = fakeRun
  const first = await applySplitRuntime({ root, platform: 'darwin', arch: 'arm64', run })
  assert.equal(first.ok, true)
  const second = await applySplitRuntime({ root, platform: 'darwin', arch: 'arm64', run })
  assert.equal(second.ok, true)
  assert.equal(second.created.engines.every(item => item.reused), true)
  assert.equal(second.created.nodes.every(item => item.reused), true)
  await rm(root, { recursive: true, force: true })
})

test('a Node that reports the wrong version publishes nothing and keeps legacy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-apply-'))
  const generation = await legacyGeneration(root, { nodeVersion: '26.13.0' })
  const report = await applySplitRuntime({ root, platform: 'darwin', arch: 'arm64', run: async () => ({ stdout: 'v20.0.0\n' }) })
  assert.equal(report.ok, false)
  assert.equal(report.created.nodes.length, 0)
  await assert.doesNotReject(stat(generation), 'legacy stays')
  const nodeEntries = await readdir(join(root, 'node')).catch(() => [])
  assert.deepEqual(nodeEntries, [])
  await rm(root, { recursive: true, force: true })
})
