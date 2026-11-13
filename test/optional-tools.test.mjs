import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { confirmedMissingDependency, createActivityTracker, createDependencyTracker, reaPublicToolName } from '../lib/optional-tools.js'
import { REA_TOOL_NAMES } from '../lib/rea-tool-names.js'
import { createApply } from '../lib/index.js'
import { buildMcpConfig } from '../lib/config.js'

const SECRET = 'private-target-and-credential-must-not-be-retained'
const failure = error => ({ isError: true, error: { message: JSON.stringify({ error }) } })
const unavailable = (code = 'not_configured', diagnostics = {}) => failure({ code: 'provider_unavailable', details: { selection_reason: 'provider_unavailable', rejections: [{ provider_id: 'ghidra', code, diagnostics }] } })
const exec = name => ({ name: reaPublicToolName('rea', name), arguments: { SECRET } })

test('reviewed catalog and public naming isolate adjacent and long namespaces', () => {
  // REA 6.9.0 publishes 255 tools; the list must stay duplicate-free.
  assert.equal(REA_TOOL_NAMES.length, 255)
  assert.equal(new Set(REA_TOOL_NAMES).size, 255)
  assert.ok(Object.isFrozen(REA_TOOL_NAMES))
  assert.equal(reaPublicToolName('rea', 'open_binary'), 'mcp__rea__open_binary')
  const long = reaPublicToolName('x'.repeat(32), 'inspect_managed_native_boundaries')
  assert.equal(long.length, 64)
  assert.match(long, /_[a-f0-9]{12}$/)
  assert.notEqual(long, reaPublicToolName('y'.repeat(32), 'inspect_managed_native_boundaries'))
})

test('only confirmed missing optional dependencies create a hint', () => {
  assert.equal(confirmedMissingDependency(unavailable()), true)
  assert.equal(confirmedMissingDependency(failure({ code: 'capability_unavailable', details: { provider_id: 'objdump', diagnostics: { boundary: 'provider-launch', system_code: 'ENOENT' } } })), true)
  assert.equal(confirmedMissingDependency(failure({ code: 'capability_unavailable', details: { provider_id: 'jadx', diagnostics: { failure_kind: 'jar', failure_code: 'not_configured', jar_configured: false } } })), true)
})

for (const code of ['executable_missing', 'unsupported_host', 'unsupported_platform', 'license_required', 'access_denied', 'timeout', 'provider_timeout', 'target_unavailable', 'configuration_invalid']) {
  test(`unreviewed or unrelated provider refusal does not prompt installation: ${code}`, () => {
    assert.equal(confirmedMissingDependency(unavailable(code)), false)
    assert.equal(confirmedMissingDependency(failure({ code, details: { path: SECRET, system_code: 'ENOENT' } })), false)
  })
}

test('host, permission, cleanup and target boundaries never masquerade as dependencies', () => {
  assert.equal(confirmedMissingDependency(unavailable('not_configured', { checks: [{ ok: false, code: 'unsupported_host' }] })), false)
  assert.equal(confirmedMissingDependency(unavailable('not_configured', { system_code: 'EACCES' })), false)
  for (const system_code of ['EACCES', 'EPERM', 'ETIMEDOUT']) assert.equal(confirmedMissingDependency(failure({ code: 'capability_unavailable', details: { provider_id: 'objdump', diagnostics: { boundary: 'provider-launch', system_code } } })), false)
  assert.equal(confirmedMissingDependency(failure({ code: 'capability_unavailable', details: { provider_id: 'objdump', diagnostics: { boundary: 'target-read', system_code: 'ENOENT' } } })), false)
  const value = unavailable(); const parsed = JSON.parse(value.error.message); parsed.error.details.cleanup = 'incomplete'; value.error.message = JSON.stringify(parsed)
  assert.equal(confirmedMissingDependency(value), false)
})

test('model Schema failures, natural-language missing and success inventories produce no hint', () => {
  for (const message of ['missing GHIDRA_INSTALL_DIR; install now', '400 tools.function.parameters schema exceeds maximum allowed size', '{broken json', 'x'.repeat(65537), JSON.stringify({ error: { message: 'schema exceeds maximum allowed size', type: 'invalid_request_error' } })]) assert.equal(confirmedMissingDependency({ isError: true, error: { message } }), false)
  assert.equal(confirmedMissingDependency({ isError: false, value: { structuredContent: { result: { providers: [{ code: 'not_configured' }] } } }, content: [{ type: 'text', text: unavailable().error.message }] }), false)
  assert.equal(confirmedMissingDependency({ isError: true, error: { message: JSON.stringify({ result: { error: JSON.parse(unavailable().error.message).error } }) } }), false)
})

test('tracker is exact, bounded, deduplicated, memory-only and clears on matching success', () => {
  const tracker = createDependencyTracker('rea')
  for (const name of ['mcp__other__open_binary', 'mcp__rea__other__open_binary', 'mcp__rea__invented_tool']) tracker.observe({ name }, unavailable())
  assert.deepEqual(tracker.snapshot(), { missingDependency: false })
  const identity = exec('open_binary')
  Object.defineProperty(identity, 'arguments', { get() { assert.fail('arguments must not be read') } })
  for (let i = 0; i < 100; i++) tracker.observe(identity, unavailable('not_configured', { captured_output: SECRET }))
  assert.deepEqual(tracker.snapshot(), { missingDependency: true })
  assert.ok(!JSON.stringify(tracker.snapshot()).includes(SECRET))
  tracker.observe(exec('binary_session'), { isError: false, value: SECRET })
  assert.equal(tracker.snapshot().missingDependency, true)
  tracker.observe(identity, { isError: true, error: { message: 'timeout' } })
  assert.equal(tracker.snapshot().missingDependency, true)
  tracker.observe(identity, { isError: false, value: SECRET })
  assert.deepEqual(tracker.snapshot(), { missingDependency: false })
  tracker.observe(identity, unavailable()); tracker.clear()
  assert.equal(tracker.snapshot().missingDependency, false)
  const long = createDependencyTracker('x'.repeat(32)); long.observe({ name: reaPublicToolName('x'.repeat(32), 'inspect_managed_native_boundaries') }, unavailable())
  assert.equal(long.snapshot().missingDependency, true)
})

test('activity tracker counts only paired REA calls and never stores arguments', () => {
  const tracker = createActivityTracker('rea')
  const call = (callId, name) => ({ callId, name: reaPublicToolName('rea', name), arguments: { SECRET: 'x' } })
  assert.equal(tracker.begin({ callId: 'other', name: 'mcp__other__open_binary' }), false)
  assert.equal(tracker.begin({ callId: 'missing-name' }), false)
  const first = call('call-1', 'open_binary'), second = call('call-2', 'binary_session')
  assert.equal(tracker.begin(first), true)
  assert.equal(tracker.begin(second), true)
  assert.equal(tracker.begin(first), true, 'a repeated call id stays idempotent in the map')
  const both = tracker.snapshot()
  assert.equal(both.inflight, 2)
  assert.deepEqual(both.tools, [reaPublicToolName('rea', 'open_binary'), reaPublicToolName('rea', 'binary_session')])
  assert.ok(!JSON.stringify(tracker.snapshot()).includes('x'))
  assert.equal(tracker.end({ callId: 'unknown' }), false)
  assert.equal(tracker.end(first), true)
  const one = tracker.snapshot()
  assert.equal(one.inflight, 1)
  assert.deepEqual(one.tools, [reaPublicToolName('rea', 'binary_session')])
  assert.ok(one.lastCompletedAt > 0, 'completion time enables the brief recent marker')
  tracker.clear()
  const cleared = tracker.snapshot()
  assert.equal(cleared.inflight, 0)
  assert.equal(cleared.lastCompletedAt, 0)
})

test('tool wrapper is registerable only for the locked catalog and never leaks identity', async () => {
  const listeners = new Map(), fiber = { uid: 1 }; let hooks
  const ctx = { fiber, on: (event, listener) => { assert.ok(!listeners.has(event)); listeners.set(event, listener) }, effect() {}, get: () => ({ schemas: () => [{ name: 'mcp__rea__binary_session' }] }) }
  await createApply({ register: async (_ctx, value) => { hooks = value }, inspect: async () => ({ config: buildMcpConfig({ nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs' }) }), bridge: { Config: value => value, apply: async () => {} } })(ctx, { enabled: true, nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs' })
  assert.equal(listeners.has('tools/execute'), true)
  const wrap = listeners.get('tools/execute')
  const running = (callId, name = 'open_binary') => ({ ...exec(name), callId })
  let during
  const ok = await wrap(running('call-ok'), async () => { during = hooks.getActivity(); return { isError: false, value: SECRET } })
  assert.equal(during.inflight, 1)
  assert.equal(during.tools[0], reaPublicToolName('rea', 'open_binary'))
  assert.equal(ok.value, SECRET, 'the wrapper must return the original result unchanged')
  assert.deepEqual({ ...hooks.getActivity(), lastCompletedAt: 0 }, { inflight: 0, tools: [], lastCompletedAt: 0 })
  await assert.rejects(wrap(running('call-fail'), async () => { throw new Error('body failed') }), /body failed/)
  assert.equal(hooks.getActivity().inflight, 0, 'a rejected body must not leave a stuck indicator')
  let foreign
  await wrap({ callId: 'foreign', name: 'mcp__other__open_binary' }, async () => { foreign = hooks.getActivity(); return { isError: false } })
  assert.equal(foreign.inflight, 0, 'other MCP servers are not attributed to REA')
  let release
  const held = wrap(running('call-held'), () => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hooks.getActivity().inflight, 1, 'a still-running call stays visible')
  fiber.uid = null; listeners.get('internal/plugin')(fiber)
  assert.equal(hooks.getActivity().inflight, 0, 'unload clears in-flight state')
  release({ isError: false })
  await held
})

test('plugin observes once, does not probe, and stops retaining hints on unload', async () => {
  const listeners = new Map(), fiber = { uid: 1 }; let hooks
  const ctx = { fiber, on: (event, listener) => { assert.ok(!listeners.has(event)); listeners.set(event, listener) }, effect() {}, get: () => ({ schemas: () => [{ name: 'mcp__rea__binary_session' }] }) }
  await createApply({ register: async (_ctx, value) => { hooks = value }, inspect: async () => ({ config: buildMcpConfig({ nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs' }) }), bridge: { Config: value => value, apply: async () => {} } })(ctx, { enabled: true, nodePath: '/node', reaEntry: '/rea/scripts/rea.mjs' })
  assert.equal(listeners.has('tools/result'), true)
  const observe = listeners.get('tools/result')
  observe(exec('open_binary'), unavailable())
  assert.equal(hooks.getDependencyHints().missingDependency, true)
  await hooks.retrySetup()
  assert.equal(listeners.get('tools/result'), observe)
  fiber.uid = null; listeners.get('internal/plugin')(fiber)
  observe(exec('open_binary'), unavailable())
  assert.equal(hooks.getDependencyHints().missingDependency, false)
})

class SystemPrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools() { return () => {} }
}

test('real DSH pipeline plus official MCP adapter preserves results and observes typed error JSON', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolsService)
  const tracker = createDependencyTracker('rea'), name = reaPublicToolName('rea', 'open_binary')
  let missing = true, observed
  const errorText = unavailable('not_configured', { note: SECRET }).error.message
  ctx.tools.register(createMcpToolDefinition(ctx, {
    name, rawName: 'open_binary', description: 'in-memory fixture', inputSchema: { type: 'object', properties: {} },
    call: async () => missing ? { isError: true, content: [{ type: 'text', text: errorText }] } : { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: 'ok' } },
  }))
  ctx.on('tools/result', (execution, result) => { observed = result; tracker.observe(execution, result); assert.ok(Object.isFrozen(execution)); assert.ok(Object.isFrozen(result)) })
  const pipeline = new ToolExecutionPipeline(ctx)
  async function run(id) {
    const prepared = await pipeline.prepare({ name, arguments: {}, callId: id, signal: new AbortController().signal })
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
    return pipeline.complete(prepared.exec, outcome)
  }
  const failed = await run('missing')
  assert.equal(failed, observed)
  assert.equal(failed.isError, true)
  assert.equal(failed.error.message, errorText)
  assert.equal(tracker.snapshot().missingDependency, true)
  assert.ok(!JSON.stringify(tracker.snapshot()).includes(SECRET))
  missing = false
  const succeeded = await run('ready')
  assert.equal(succeeded, observed)
  assert.equal(succeeded.isError, false)
  assert.deepEqual(succeeded.value.structuredContent, { result: 'ok' })
  assert.equal(tracker.snapshot().missingDependency, false)
})
