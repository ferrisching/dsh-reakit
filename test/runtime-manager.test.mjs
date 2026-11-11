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

test('a lost response after accepted edit is refreshed, not replayed', async t => {
  const f = await fixture(t), token = (await f.manager.checkUpdates()).token
  f.applyThenFail()
  await assert.rejects(f.manager.prepareSwitch(token, CONFIRM), /response lost/)
  assert.equal(f.writes.length, 1)
  assert.equal(f.getCurrent().managedReaVersion, '6.9.0')
  assert.equal(f.manager.status().transition.state, 'ready')
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



test('a pair inside the managed root may be replaced by a version switch', async t => {
  const f = await fixture(t)
  const root = f.root
  const node = join(root, 'node', 'darwin-arm64-26.13.0-abc', 'bin', 'node')
  await mkdir(dirname(node), { recursive: true })
  f.setCurrent({ enabled: true, runtimeDir: root, nodePath: node, reaEntry: join(root, 'engine', 'rea-x', 'rea.mjs'), managedReaVersion: '6.8.0', managedNodeRange: RANGE, env: {} })
  f.setRuntime({ phase: 'ready', reaVersion: '6.8.0', nodeVersion: 'v26.13.0', nodeRange: RANGE })
  const token = (await f.manager.checkUpdates()).token
  await f.manager.prepareSwitch(token, CONFIRM)
  assert.equal(f.writes.length > 0, true, 'the switch was allowed to write the new pair')
})

test('an adopted pair outside the managed root is still refused', async t => {
  const f = await fixture(t)
  f.setCurrent({ enabled: true, runtimeDir: f.root, nodePath: '/opt/homebrew/bin/node', reaEntry: '/tmp/rea.mjs', managedReaVersion: '', managedNodeRange: '', env: {} })
  const token = (await f.manager.checkUpdates()).token
  await assert.rejects(f.manager.prepareSwitch(token, CONFIRM), /manual runtime configuration/)
})
