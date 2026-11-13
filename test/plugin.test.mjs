import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, createApply, inject, name } from '../lib/index.js'
import * as realBridge from '@deepseek-ai/dsh-mcp-client'
import { buildMcpConfig } from '../lib/config.js'

const settings = { enabled: true, nodePath: '/runtime/node', reaEntry: '/rea/scripts/rea.mjs' }

test('plugin identity and safe defaults', () => {
  assert.equal(name, 'rea')
  assert.deepEqual(inject, ['tools'])
  // Installing does not turn REA on; the user opts in when they need it.
  assert.equal(Config({}).enabled, false)
  assert.equal(Config({}).autoSetup, true)
  assert.equal(Config({}).showComposerToggle.get(), true)
  assert.equal(Config({ showComposerToggle: false }).showComposerToggle.get(), false)
  assert.equal(Config.dict.showComposerToggle.meta.volatile, true)
  assert.equal(Config({}).outputSchemaProfile, 'off')
})

test('published REA 6.9.0 rejects unsupported compact output advertisements', () => {
  assert.throws(() => Config({ outputSchemaProfile: 'compact' }))
  assert.equal(Config({ outputSchemaProfile: 'full' }).outputSchemaProfile, 'full')
})

test('disabled activation neither preflights nor connects', async () => {
  const apply = createApply({ inspect: () => { throw new Error('must not run') } })
  await apply({}, { enabled: false })
})

test('dynamic managed metadata must be complete and accompany explicit runtime paths', async () => {
  const apply = createApply({ inspect: () => { throw new Error('must not inspect incomplete dynamic settings') } })
  await assert.rejects(apply({}, { enabled: true, nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs', managedReaVersion: '6.10.0' }), /managedReaVersion/)
  await assert.rejects(apply({}, { enabled: true, managedReaVersion: '6.10.0', managedNodeRange: '>=24.22.1' }), /managedReaVersion/)
})

test('wrapper delegates validated launch to official bridge on the same owned context', async () => {
  const context = {}
  const launch = buildMcpConfig(settings)
  let inspected = false
  let connected = false
  const apply = createApply({
    inspect: async (config) => {
      assert.equal(config.nodePath, settings.nodePath)
      inspected = true
      return { config: launch }
    },
    bridge: {
      Config: realBridge.Config,
      apply: async (ctx, config) => {
        assert.equal(ctx, context)
        assert.equal(config.command, settings.nodePath)
        assert.deepEqual(config.args, [settings.reaEntry, 'mcp'])
        assert.equal(config.failOnStartupError, true)
        connected = true
      },
    },
  })
  await apply(context, settings)
  assert.ok(inspected && connected)
})

test('preflight failure propagates without registering tools', async () => {
  const apply = createApply({
    inspect: async () => { throw new Error('old Node') },
    bridge: { apply: () => assert.fail('must not connect') },
  })
  await assert.rejects(apply({}, settings), /old Node/)
})

test('zero-config activation prepares the runtime without manual paths', async () => {
  let preparations = 0
  let hooks
  const apply = createApply({
    register: async (_ctx, registered) => { hooks = registered },
    prepare: async (config) => { preparations++; assert.equal(config.nodePath, ''); return { nodeVersion: 'v24.22.1', reaVersion: '6.9.0', config: buildMcpConfig(settings) } },
    bridge: { Config: realBridge.Config, apply: async () => {} },
  })
  await apply({}, { nodePreference: 'managed', enabled: true })
  assert.equal(preparations, 1)
  assert.equal(hooks.getRuntimeState().phase, 'ready')
  await hooks.retrySetup()
  assert.equal(preparations, 1)
})

test('setup failures are explained by cause, not raw errno', async () => {
  const cases = [
    [Object.assign(new Error('write failed'), { code: 'ENOSPC' }), /disk space/i],
    [Object.assign(new Error('denied'), { code: 'EACCES' }), /writable by your user/i],
    [Object.assign(new Error('x'), { code: 'ENOTFOUND' }), /connection or proxy/i],
  ]
  for (const [error, pattern] of cases) {
    let hooks
    const apply = createApply({
      register: async (_ctx, registered) => { hooks = registered },
      prepare: async () => { throw error },
      bridge: { Config: realBridge.Config, apply: async () => {} },
    })
    await apply({}, { nodePreference: 'managed', enabled: true })
    assert.equal(hooks.getRuntimeState().phase, 'error')
    assert.match(hooks.getRuntimeState().message, pattern)
  }
})

test('automatic setup failure stays observable and can retry without disabling details', async () => {
  let attempts = 0, hooks
  const apply = createApply({
    register: async (_ctx, registered) => { hooks = registered },
    prepare: async () => { if (++attempts === 1) throw new Error('network unavailable'); return { config: buildMcpConfig(settings) } },
    bridge: { Config: realBridge.Config, apply: async () => {} },
  })
  await apply({}, { nodePreference: 'managed', enabled: true })
  assert.equal(hooks.getRuntimeState().phase, 'error')
  assert.match(hooks.getRuntimeState().message, /network unavailable/)
  await hooks.retrySetup()
  assert.equal(hooks.getRuntimeState().phase, 'ready')
})

test('missing tool registration is not shown as ready and retry replaces the bridge', async () => {
  let names = [], hooks, connections = 0, disposals = 0
  const ctx = {
    get: () => ({ schemas: () => names.map(name => ({ name })) }),
    plugin: () => {
      connections++; names = ['mcp__rea__binary_session']
      const fiber = Promise.resolve()
      fiber.dispose = async () => { disposals++; names = [] }
      return fiber
    },
  }
  const apply = createApply({
    register: async (_ctx, value) => { hooks = value },
    inspect: async () => ({ config: buildMcpConfig(settings) }),
    bridge: { Config: realBridge.Config },
  })
  await apply(ctx, settings)
  assert.equal(hooks.getRuntimeState().phase, 'ready')
  names = []
  assert.equal(hooks.getRuntimeState().phase, 'error')
  await hooks.retrySetup()
  assert.equal(hooks.getRuntimeState().phase, 'ready')
  assert.equal(connections, 2)
  assert.equal(disposals, 1)
})

test('partial manual configuration fails rather than downloading silently', async () => {
  const apply = createApply({ prepare: () => assert.fail('must not prepare') })
  await assert.rejects(apply({}, { enabled: true, nodePath: '/node' }), /both nodePath and reaEntry/)
})

test('unload aborts preparation before cleanup waits for it', async () => {
  let listener, ready
  const started = new Promise(resolve => { ready = resolve })
  const ctx = { fiber: { uid: 1 }, on: (event, callback) => { if (event === 'internal/plugin') listener = callback }, effect: () => {} }
  const apply = createApply({
    register: async () => {},
    prepare: async (_settings, { signal }) => { ready(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
  })
  const pending = apply(ctx, { nodePreference: 'managed', enabled: true })
  await started
  ctx.fiber.uid = null
  listener(ctx.fiber)
  await assert.rejects(pending, /unloaded/)
})

test('connection failure propagates, never claiming successful activation', async () => {
  const apply = createApply({
    inspect: async () => ({ config: buildMcpConfig(settings) }),
    bridge: { Config: realBridge.Config, apply: async () => { throw new Error('handshake failed') } },
  })
  await assert.rejects(apply({}, settings), /handshake failed/)
})
