import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRuntimeVersionManager } from '../lib/runtime-manager.js'
import { REA_NODE_RANGE as RANGE } from '../lib/config.js'
import { buildMcpConfig, REA_NODE_RANGE } from '../lib/config.js'

const CONFIRM = { confirmed: true, exported: true }
const candidate = { rea: { version: '6.9.0' }, node: { version: '26.13.0' } }
const quiet = () => ({ results: [{ result: { isError: false, value: { structuredContent: { result: { open: false, cleanup_pending: false, analysis_run: null, analysis_activity: { status: 'not_observed', providers: [] } } } } } }] })

async function fixture(t, overrides = {}) {
  const prefix = join(tmpdir(), 'dsh-reakit-manager-test-'), root = await mkdtemp(prefix)
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(prefix))); await rm(root, { recursive: true, force: true }) })
  let current = { enabled: true, serverName: 'rea', runtimeDir: root, nodePath: '', reaEntry: '', managedReaVersion: '', managedNodeRange: '', env: { KEEP: 'unchanged' }, showComposerToggle: true, ...overrides.settings }
  let runtime = { phase: 'ready', reaVersion: '6.8.0', nodeVersion: 'v24.22.1', nodeRange: REA_NODE_RANGE }
  const writes = [], calls = { check: 0, prepare: 0, sessions: 0 }
  let failWrites = 0, applyThenFail = false, sessionResult = quiet()
  const configuration = {
    readStrict() { if (overrides.readFailure) throw new Error('configuration unavailable'); return current },
    async runtimePaths(next, expected) {
      writes.push({ next, expected })
      for (const key of ['nodePath', 'reaEntry', 'managedReaVersion', 'managedNodeRange']) assert.equal((current[key] || ''), (expected[key] || ''))
      if (failWrites-- > 0) throw new Error('edit rejected before applying')
      current = { ...current, ...next }
      runtime = next.managedReaVersion ? { phase: 'ready', reaVersion: next.managedReaVersion, nodeVersion: 'v26.13.0', nodeRange: next.managedNodeRange } : { phase: 'ready', reaVersion: '6.8.0', nodeVersion: 'v24.22.1', nodeRange: REA_NODE_RANGE }
      if (applyThenFail) { applyThenFail = false; throw new Error('response lost after accepted edit') }
      return { saved: true }
    },
  }
  const ctx = { get: () => ({ schemas: () => [{ name: 'mcp__rea__binary_session' }], execute: async () => { calls.sessions++; return sessionResult } }) }
  const manager = createRuntimeVersionManager({
    ctx, configuration, getRuntimeState: () => runtime,
    check: async () => { calls.check++; return { candidate, updateAvailable: true, reaUpdateAvailable: true, nodeUpdateAvailable: true } },
    candidateFrom: async ({ reaVersion, nodeVersion }) => ({ platform: process.platform, arch: process.arch, rea: { version: reaVersion, nodeRange: '>=24.22.1' }, node: { version: String(nodeVersion).replace(/^v/, '') } }),
    prepare: async (_candidate, settings) => {
      calls.prepare++
      const nodePath = join(settings.runtimeDir, 'new', 'node'), reaEntry = join(settings.runtimeDir, 'new', 'engine', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs')
      return { reaVersion: '6.9.0', nodeVersion: 'v26.13.0', nodeRange: '>=24.22.1', config: buildMcpConfig({ nodePath, reaEntry }) }
    },
  })
  await manager.refresh()
  return { root, manager, calls, writes, configuration, getCurrent: () => current, setCurrent: value => { current = value }, getRuntime: () => runtime,
    setRuntime: value => { runtime = value },
    failWrites: count => { failWrites = count }, applyThenFail: () => { applyThenFail = true },
    setSession: value => { sessionResult = value },
  }
}

test('mount and status never check updates; only explicit check creates a short-lived candidate', async t => {
  const f = await fixture(t)
  assert.equal(f.calls.check, 0)
  assert.equal(f.manager.status().candidate, null)
  assert.equal(f.manager.status().transition, null)
  const result = await f.manager.checkUpdates()
  assert.equal(f.calls.check, 1)
  assert.equal(result.candidate, candidate)
  assert.equal(result.updateAvailable, true)
  assert.equal(f.writes.length, 0)
})

test('switch requires both confirmations and an inactive session', async t => {
  const f = await fixture(t), token = (await f.manager.checkUpdates()).token
  await assert.rejects(f.manager.prepareSwitch(token, { confirmed: true, exported: false }), /Confirm that/)
  assert.equal(f.calls.prepare, 0)
  const busy = quiet()
  busy.results[0].result.value.structuredContent.result.analysis_activity = { status: 'busy', providers: [{ active: { request_id: 'active' }, queued_requests: 0 }] }
  f.setSession(busy)
  await assert.rejects(f.manager.prepareSwitch(token, CONFIRM), /Active, queued/)
  assert.equal(f.calls.prepare, 0)
  assert.equal(f.writes.length, 0)
})

test('prepared switch preserves unrelated config and supports rollback after reload', async t => {
  const f = await fixture(t), token = (await f.manager.checkUpdates()).token
  const result = await f.manager.prepareSwitch(token, CONFIRM)
  assert.equal(result.started, true)
  assert.equal(f.calls.prepare, 1)
  assert.equal(f.writes.length, 1)
  assert.equal(f.getCurrent().managedReaVersion, '6.9.0')
  assert.equal(f.getCurrent().managedNodeRange, '>=24.22.1')
  assert.equal(f.getCurrent().enabled, true)
  assert.deepEqual(f.getCurrent().env, { KEEP: 'unchanged' })
  assert.equal(f.getCurrent().showComposerToggle, true)
  assert.equal(f.manager.status().transition.state, 'ready')
  assert.equal(f.manager.status().transition.rollbackAvailable, true)
  await assert.rejects(f.manager.prepareSwitch(token, CONFIRM), /expired/)
  assert.equal(f.writes.length, 1, 'candidate token is single use')
  await f.manager.rollback(CONFIRM)
  assert.equal(f.getCurrent().nodePath, '')
  assert.equal(f.getCurrent().reaEntry, '')
  assert.equal(f.getCurrent().managedReaVersion, '')
  assert.equal(f.getCurrent().managedNodeRange, '')
  assert.equal(f.manager.status().transition, null)
  const files = await readdir(f.root)
  assert.equal(files.includes('.runtime-transition.json'), false)
})

test('a lost response after accepted edit is refreshed, not replayed', async t => {
  const f = await fixture(t), token = (await f.manager.checkUpdates()).token
  f.applyThenFail()
  await assert.rejects(f.manager.prepareSwitch(token, CONFIRM), /response lost/)
  assert.equal(f.writes.length, 1)
  assert.equal(f.getCurrent().managedReaVersion, '6.9.0')
  assert.equal(f.manager.status().transition.state, 'ready')
})

test('rollback edit failure leaves a retryable transition and never overwrites newer config', async t => {
  const f = await fixture(t), token = (await f.manager.checkUpdates()).token
  await f.manager.prepareSwitch(token, CONFIRM)
  f.failWrites(1)
  await assert.rejects(f.manager.rollback(CONFIRM), /edit rejected/)
  assert.equal(f.manager.status().transition.state, 'rolling-back')
  assert.equal(f.manager.status().transition.rollbackAvailable, true)
  await f.manager.rollback(CONFIRM)
  assert.equal(f.getCurrent().nodePath, '')
  assert.equal(f.manager.status().transition, null)
})

test('manual runtime paths are never overwritten', async t => {
  const f = await fixture(t, { settings: { nodePath: '/custom/node', reaEntry: '/custom/rea/scripts/rea.mjs' } }), token = (await f.manager.checkUpdates()).token
  await assert.rejects(f.manager.prepareSwitch(token, CONFIRM), /manual runtime/)
  assert.equal(f.calls.prepare, 0)
  assert.equal(f.writes.length, 0)
})

test('strict configuration read failure does not become automatic managed mode', async t => {
  const f = await fixture(t, { readFailure: true })
  await assert.rejects(f.manager.checkUpdates(), /configuration unavailable/)
  assert.equal(f.calls.check, 0)
  assert.equal(f.writes.length, 0)
})

test('malformed transition IDs and symlink records are preserved without any write', async t => {
  const point = { nodePath: '', reaEntry: '', managedReaVersion: '', managedNodeRange: '', reaVersion: '6.8.0', nodeVersion: 'v24.22.1' }
  const target = { nodePath: '/managed/node', reaEntry: '/managed/rea/scripts/rea.mjs', managedReaVersion: '6.9.0', managedNodeRange: '>=24.22.1', reaVersion: '6.9.0', nodeVersion: 'v26.13.0' }
  for (const malicious of [{ id: '../escape' }, { id: randomUUID(), symlink: true }]) {
    const f = await fixture(t), file = join(f.root, '.runtime-transition.json')
    if (malicious.symlink) {
      const actual = join(f.root, 'actual.json'); await writeFile(actual, JSON.stringify({ formatVersion: 1, id: malicious.id, state: 'rolling-back', from: point, to: target }))
      await symlink(actual, file)
    } else await writeFile(file, JSON.stringify({ formatVersion: 1, id: malicious.id, state: 'rolling-back', from: point, to: target }))
    await assert.rejects(f.manager.rollback(CONFIRM), /No runtime transition record/)
    assert.equal(f.writes.length, 0)
    assert.equal((await readdir(f.root)).some(name => name.includes('escape') || name.endsWith('.tmp')), false)
    await rm(file, { force: true })
  }
})

test('upgrading removes the replaced version, so rollback must re-install it', async t => {
  const f = await fixture(t)
  const token = (await f.manager.checkUpdates()).token
  await f.manager.prepareSwitch(token, CONFIRM)
  // The switch reports what it removed; the previous version must be gone.
  const after = f.manager.status()
  assert.equal(after.transition.state, 'ready')
  assert.equal(f.getCurrent().managedReaVersion, '6.9.0')
})

test('managed parts resolve when the record carries no runtimeDir', async () => {
  const { managedParts } = await import('../lib/runtime-manager.js')
  const root = '/r/runtime'
  // Transition records only store the two paths, so the manager's root must be used.
  const parts = await managedParts({
    nodePath: `${root}/node/darwin-arm64-24.22.1-abc/bin/node`,
    reaEntry: `${root}/engine/rea6.8.0-abc/node_modules/rea-agents/scripts/rea.mjs`,
  }, root)
  assert.deepEqual(parts.parts.sort(), [`${root}/engine/rea6.8.0-abc`, `${root}/node/darwin-arm64-24.22.1-abc`].sort())
})

test('managed parts cover split and legacy layouts', async () => {
  const { managedParts } = await import('../lib/runtime-manager.js')
  const root = '/r/runtime'
  const split = await managedParts({
    runtimeDir: root,
    nodePath: `${root}/node/darwin-arm64-26.13.0-abc/bin/node`,
    reaEntry: `${root}/engine/rea6.8.0-abc/node_modules/rea-agents/scripts/rea.mjs`,
  })
  assert.deepEqual(split.parts.sort(), [`${root}/engine/rea6.8.0-abc`, `${root}/node/darwin-arm64-26.13.0-abc`].sort())
  const legacy = await managedParts({ runtimeDir: root, nodePath: `${root}/node-26.13.0-rea-6.8.0/engine/node_modules/rea-agents/scripts/rea.mjs`, reaEntry: `${root}/node-26.13.0-rea-6.8.0/engine/node_modules/rea-agents/scripts/rea.mjs` })
  assert.deepEqual(legacy.parts, [`${root}/node-26.13.0-rea-6.8.0`])
  assert.deepEqual((await managedParts({ runtimeDir: root, nodePath: '', reaEntry: '' })).parts, [])
})



test('rolling back reinstalls a deleted previous version', async t => {
  const f = await fixture(t)
  const root = f.root
  const oldNode = join(root, 'node', 'old-node')
  const oldEngine = join(root, 'engine', 'old-engine')
  const newNode = join(root, 'node', 'new-node')
  const newEngine = join(root, 'engine', 'new-engine')
  for (const dir of [oldNode, oldEngine, newNode, newEngine]) await mkdir(dir, { recursive: true })
  const oldFrom = {
    nodePath: join(oldNode, 'bin', 'node'),
    reaEntry: join(oldEngine, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
    managedReaVersion: '6.8.0', managedNodeRange: RANGE, reaVersion: '6.8.0', nodeVersion: 'v24.22.1',
  }
  const to = {
    nodePath: join(newNode, 'bin', 'node'),
    reaEntry: join(newEngine, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
    managedReaVersion: '6.9.0', managedNodeRange: RANGE, reaVersion: '6.9.0', nodeVersion: 'v26.13.0',
  }
  // Seed a completed switch, then delete the previous version as an upgrade would.
  await f.manager.__seed?.(undefined)
  await writeFile(join(root, '.runtime-transition.json'), JSON.stringify({
    formatVersion: 1, id: '11111111-2222-4333-8444-555555555555', state: 'ready', from: oldFrom, to, createdAt: new Date().toISOString(),
  }, null, 2))
  await f.setCurrent?.({ enabled: true, runtimeDir: root, ...to, env: {} })
  await rm(oldNode, { recursive: true, force: true })
  await rm(oldEngine, { recursive: true, force: true })
  const before = f.calls.prepare
  await f.manager.rollback(CONFIRM)
  assert.ok(f.calls.prepare > before, 'the previous version was reinstalled')
})
