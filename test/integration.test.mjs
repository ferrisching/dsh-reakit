import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, rm, writeFile as writeText } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as realMcp from '@deepseek-ai/dsh-mcp-client'
import { createApply, Config, inject } from '../lib/index.js'
import { buildMcpConfig } from '../lib/config.js'

// The host and official bridge are real; only the upstream REA process is simulated.
class FixtureTools extends Service {
  definitions = new Map()
  constructor(ctx) { super(ctx, 'tools') }
  register(definition) {
    if (this.definitions.has(definition.name)) throw new Error('Duplicate tool')
    this.definitions.set(definition.name, definition)
    return () => this.definitions.delete(definition.name)
  }
}

test('config disable during initialization aborts before Cordis waits for apply', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let ready, aborted = false
  const started = new Promise(resolve => { ready = resolve })
  const plugin = { name: 'rea-abort-loading-test', Config, apply: createApply({
    register: async () => {},
    prepare: async (_config, { signal }) => {
      ready()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
    },
  }) }
  const fiber = ctx.plugin(plugin, { nodePreference: 'managed' })
  await started
  await fiber.update({ enabled: false })
  assert.equal(aborted, true)
  assert.equal(fiber.effectiveConfig.enabled, false)
})

test('production background initialization leaves the settings owner active and cancelable', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let ready, aborted = false
  const started = new Promise(resolve => { ready = resolve })
  const plugin = { name: 'rea-background-settings-test', Config, apply: createApply({
    background: true, register: async () => {},
    prepare: async (_config, { signal }) => {
      ready()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
    },
  }) }
  const fiber = ctx.plugin(plugin, { nodePreference: 'managed' })
  await fiber
  await started
  assert.equal(fiber.state, 2)
  await fiber.update({ enabled: false })
  assert.equal(aborted, true)
  assert.equal(fiber.effectiveConfig.enabled, false)
})

test('disposing during a child handshake disposes the child before awaiting apply', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let ready, childDisposed = false
  const started = new Promise(resolve => { ready = resolve })
  const bridge = {
    name: 'rea-pending-handshake-test',
    Config: realMcp.Config,
    apply: async child => {
      await new Promise(resolve => {
        child.on('internal/plugin', fiber => {
          if (fiber === child.fiber && fiber.uid === null) { childDisposed = true; resolve() }
        }, { global: true })
        ready()
      })
    },
  }
  const plugin = { name: 'rea-abort-child-test', Config, apply: createApply({
    register: async () => {}, bridge,
    inspect: async () => ({ config: buildMcpConfig({ nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs' }) }),
  }) }
  const fiber = ctx.plugin(plugin, { nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs' })
  await started
  await fiber.dispose()
  assert.equal(childDisposed, true)
})

test('live composer visibility preserves the running bridge and in-memory session', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let starts = 0, disposals = 0
  const bridge = { name: 'rea-live-visibility-bridge', Config: realMcp.Config, apply: child => {
    starts++
    child.effect(() => () => { disposals++ })
  } }
  const plugin = { name: 'rea-live-visibility-test', Config, apply: createApply({
    bridge, register: async () => {},
    inspect: async () => ({ config: buildMcpConfig({ nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs' }) }),
  }) }
  const config = { enabled: true, nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs' }
  const fiber = ctx.plugin(plugin, config)
  await fiber
  const uid = fiber.uid
  for (const visible of [false, true, false]) {
    await fiber.update({ ...config, showComposerToggle: visible })
    assert.equal(fiber.uid, uid)
    assert.equal(fiber.effectiveConfig.showComposerToggle.get(), visible)
    assert.equal(starts, 1)
    assert.equal(disposals, 0)
  }
  await fiber.update({ ...config, showComposerToggle: false, enabled: false })
  assert.equal(disposals, 1)
  assert.equal(fiber.effectiveConfig.enabled, false)
})

test('real Cordis + official MCP bridge: discover, call, error and dispose', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(FixtureTools)
  const launch = buildMcpConfig({
    nodePath: process.execPath,
    reaEntry: fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)),
    cwd: process.cwd(),
    toolCallTimeoutMs: 5000,
  })
  launch.reconnect.enabled = false
  const plugin = { name: 'rea-integration-fixture', inject, Config, apply: createApply({ inspect: async () => ({ config: launch }), register: async () => {} }) }
  const fiber = ctx.plugin(plugin, { enabled: true, nodePath: launch.command, reaEntry: launch.args[0] })
  await fiber
  const tools = ctx.tools.definitions
  assert.deepEqual([...tools.keys()], ['mcp__rea__fixture_echo'])
  const echo = tools.get('mcp__rea__fixture_echo')
  const execution = { signal: new AbortController().signal }
  assert.deepEqual(await echo.execute({ message: 'hello' }, execution), { content: [{ type: 'text', text: 'hello' }] })
  await assert.rejects(echo.execute({ message: 'fail' }, execution), /Fixture failure/)
  await fiber.dispose()
  assert.equal(tools.size, 0)
})

test('a Node chosen from the machine is validated as a plain pair, not as a managed runtime', async () => {
  const { inspectManagedRuntime } = await import('../lib/runtime-versions.js')
  const root = await mkdtemp(join(tmpdir(), 'reakit-hostnode-'))
  const engine = join(root, 'engine', 'rea-test')
  await mkdir(join(engine, 'node_modules', 'rea-agents', 'scripts'), { recursive: true })
  await writeText(join(engine, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'), 'export {}\n')
  await writeText(join(engine, 'node_modules', 'rea-agents', 'package.json'), JSON.stringify({ name: 'rea-agents', version: '6.8.0', engines: { node: '>=20' } }))
  const settings = {
    runtimeDir: root,
    nodePath: '/opt/homebrew/bin/node',
    reaEntry: join(engine, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
    managedReaVersion: '6.8.0',
    managedNodeRange: '>=20',
  }
  // A machine Node is outside the managed root, so the managed probe declines
  // instead of throwing; the caller falls back to the plain inspection path.
  assert.equal(await inspectManagedRuntime(settings), null)
  await rm(root, { recursive: true, force: true })
})
