import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
const CONFIG_CHANGED = 'dsh-reakit:configuration-changed'
const ENTRY_ID = 'fixture-rea-settings'
const SECRET = 'fixture-secret-never-copy-7b29'
const PRIVATE_PATH = '/fixture/private/rea-config'
const flush = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.children) : typeof tree === 'string' ? tree : ''
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.children, predicate)]
}
function one(tree, predicate) {
  const matches = nodes(tree, predicate)
  assert.equal(matches.length, 1, 'expected exactly one matching element')
  return matches[0]
}
const section = tree => one(tree, node => node.props?.['data-rea-optional-tools'])
const details = tree => one(section(tree), node => node.props?.['data-rea-config-instructions'])
const prompt = tree => text(one(section(tree), node => node.type === 'pre'))
const copyButton = tree => one(section(tree), node => node.type === 'button' && text(node) === '复制配置指令')
const switchIn = tree => one(tree, node => node.type === 'button' && node.props.role === 'switch')
const alerts = tree => nodes(tree, node => node.props?.role === 'alert').map(text).join('\n')

// A tiny explicit render/commit harness, not a browser or React reconciler.
function hookHarness() {
  let active
  const frames = new Set()
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  function slot(kind) {
    const index = active.cursor++
    const hook = active.hooks[index] ||= { kind }
    assert.equal(hook.kind, kind)
    return hook
  }
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const frame = active, hook = slot('state')
      if (!hook.initialized) { hook.value = typeof initial === 'function' ? initial() : initial; hook.initialized = true }
      return [hook.value, value => { if (!frame.mounted) frame.lateUpdates++; hook.value = typeof value === 'function' ? value(hook.value) : value }]
    },
    useRef(initial) { const hook = slot('ref'); return hook.value ||= { current: initial } },
    useMemo(factory, deps) {
      const hook = slot('memo')
      if (!same(hook.deps, deps)) { hook.value = factory(); hook.deps = deps }
      return hook.value
    },
    useEffect(effect, deps) {
      const hook = slot('effect')
      if (!same(hook.deps, deps)) { active.effects.push(() => { hook.cleanup?.(); hook.cleanup = effect() }); hook.deps = deps }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const hook = slot('store')
      if (hook.subscribe !== subscribe) {
        active.effects.push(() => { hook.cleanup?.(); hook.cleanup = subscribe(() => {}) })
        hook.subscribe = subscribe
      }
      return getSnapshot()
    },
  }
  function mount(element) {
    assert.equal(typeof element.type, 'function')
    const frame = {
      hooks: [], effects: [], mounted: true, lateUpdates: 0, props: element.props,
      render(props = frame.props) {
        assert.ok(frame.mounted)
        frame.cursor = 0; frame.props = props; active = frame
        try { frame.tree = element.type(props) } finally { active = undefined }
        frame.effects.splice(0).forEach(commit => commit())
        return frame.tree
      },
      unmount() { if (frame.mounted) { frame.mounted = false; frame.hooks.forEach(hook => hook.cleanup?.()) } },
    }
    frames.add(frame); frame.render()
    return frame
  }
  return { react, mount, dispose: () => frames.forEach(frame => frame.unmount()) }
}

function status(secret = SECRET) {
  return {
    enabled: true, configurationWritable: true, settingsEntryId: ENTRY_ID,
    runtime: { phase: 'ready', nodePath: PRIVATE_PATH, token: secret, reaVersion: '6.9.0', nodeVersion: 'v24.22.1' },
    runtimeVersions: { phase: 'idle', candidate: null, transition: null },
    env: { API_TOKEN: secret },
    components: Array.from({ length: 23 }, (_, index) => ({
      id: `component-${index}`, name: `不应渲染的组件 ${index}`, status: 'missing',
      keys: ['API_TOKEN'], values: { API_TOKEN: secret }, aiPrompt: `不应使用的动态提示 ${secret}`,
    })),
  }
}
function fixture(t, options = {}) {
  const hooks = hookHarness(), timers = new Map(), listeners = new Map(), calls = [], copies = [], writes = [], subscribers = new Set()
  const events = new EventTarget(), registrations = []
  let exported, nextTimer = 0
  const host = options.host || { current: options.status || status() }
  let snapshot = { status: 'ready', writable: true, value: { showComposerToggle: true, API_TOKEN: SECRET } }
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) },
    async set(key, value) {
      writes.push([key, value]); snapshot = { ...snapshot, value: { ...snapshot.value, [key]: value } }
      subscribers.forEach(listener => listener()); return true
    },
  }
  const window = {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); events.addEventListener(name, listener) },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); events.removeEventListener(name, listener) },
    dispatchEvent: event => events.dispatchEvent(event),
    __ModuleLoader__: { load({ factory }) { exported = factory(name => { assert.equal(name, 'react'); return hooks.react }) } },
  }
  if (options.BroadcastChannel) window.BroadcastChannel = options.BroadcastChannel
  const globals = {
    window, Event, AbortController,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
  }
  if (options.clipboard !== 'no-navigator') globals.navigator = options.clipboard === 'missing' ? {} : {
    clipboard: { async writeText(value) { copies.push(value); if (options.clipboard === 'rejected') throw new Error('clipboard denied'); await options.writeText?.(value) } },
  }
  // No fetch, Node require, real timers, configuration, devices or install tools.
  vm.runInNewContext(source, globals, { filename: 'dsh-reakit/client/client.js' })
  const dictionaries = []
  const locale = { register(namespace, messages) { dictionaries.push({ namespace, messages }); return () => {} } }
  exported.apply({
    get(name) { return name === 'locale' ? locale : undefined },
    effect(callback) { return callback() },
    slots: {
      inject(name, callback) { return callback() },
      register(options, render) { registrations.push({ ...options, render }) },
    },
    configForms: { get(id) { assert.equal(id, ENTRY_ID); return form } },
    connection: { rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); calls.push({ endpoint, payload, signal })
      if (endpoint === 'reaComponents/status') return { ok: true, value: await host.current }
      if (endpoint === 'reaComponents/setMode') {
        const mode = payload.args.mode
        host.current = { ...host.current, enabled: mode !== 'off', toolRouting: mode === 'off' ? host.current.toolRouting : mode, mode }
        return { ok: true, value: { message: 'fixture saved', mode } }
      }
      if (endpoint === 'reaComponents/optionalDependencies') {
        return { ok: true, value: { reaVersion: '6.9.0', visibleFamilies: [], components: [] } }
      }
      if (endpoint === 'reaComponents/checkRuntimeUpdates') {
        const value = options.versionResult || { phase: 'checked', candidate: null, updateAvailable: false, message: 'checked' }
        host.current = { ...host.current, runtimeVersions: value }
        return { ok: true, value }
      }
      if (endpoint === 'reaComponents/prepareRuntimeSwitch' || endpoint === 'reaComponents/rollbackRuntime') {
        const value = { ...host.current.runtimeVersions, phase: endpoint === 'reaComponents/rollbackRuntime' ? 'rolling-back' : 'switching' }
        host.current = { ...host.current, runtimeVersions: value }
        return { ok: true, value: { started: true, ...value } }
      }
      return { ok: false, error: { message: `unexpected RPC: ${endpoint}` } }
    } } },
  })
  const registration = id => { const found = registrations.filter(item => item.id === id); assert.equal(found.length, 1); return found[0] }
  const element = id => registration(id).render(id === 'dsh-reakit.components' ? { subject: { kind: 'bundle', pkg: { name: 'dsh-reakit' } } } : {})
  const result = {
    ...hooks, calls, copies, writes, timers, listeners, subscribers, registrations, registration, element, form, dictionaries,
    panel: () => hooks.mount(element('dsh-reakit')),
    setStatus: value => { host.current = value },
    fire: name => events.dispatchEvent(new Event(name)),
    tick() { const pending = [...timers]; pending.forEach(([id, timer]) => { timers.delete(id); timer.callback() }) },
  }
  t.after(result.dispose)
  return result
}
const assertStatusOnly = f => assert.ok(f.calls.every(call => ['reaComponents/status', 'reaComponents/optionalDependencies'].includes(call.endpoint)), `unexpected RPCs: ${f.calls.map(call => call.endpoint)}`)

function assertMinimal(tree) {
  assert.equal(section(tree).type, 'details')
  assert.equal(section(tree).props.open, false)
  assert.match(text(one(section(tree), node => node.type === 'summary' && text(node).includes('可选工具配置'))), /可选工具配置/)
  assert.equal(nodes(tree, node => node.props?.['data-rea-dependency-hint']).length, 0)
  assert.doesNotMatch(text(tree), /AI 安装/)
  assert.ok(text(one(details(tree), node => node.type === 'summary')).length > 0)
  assert.equal(nodes(tree, node => node.props && Object.hasOwn(node.props, 'data-rea-component')).length, 0)
  assert.equal(nodes(tree, node => node.type === 'form' || node.type === 'textarea' || node.type === 'input' && node.props.type !== 'checkbox').length, 0)
  assert.doesNotMatch(text(tree), /不应渲染的组件|自动管理的 Node|安装计划确认|确认并实际安装|预览 Homebrew|保存组件配置|重新检测组件/)
  assert.equal(nodes(tree, node => node.type === 'button').length, 2, 'only global toggle and copy action remain')
  const css = text(one(tree, node => node.type === 'style' && node.props['data-rea-panel-style']))
  assert.match(css, /\.rea-optional:not\(\[open\]\)>\.rea-optional-body\{display:none;\}/)
  assert.match(css, /\[data-rea-config-instructions\]:not\(\[open\]\)>pre\{display:none;\}/)
}

test('Settings and Detail share the minimal Panel even with 23 component records', async t => {
  const f = fixture(t), settings = f.element('dsh-reakit'), detail = f.element('dsh-reakit.components')
  assert.equal(settings.type, detail.type)
  assert.equal(f.registration('dsh-reakit.components').render({ subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } }), null)
  const panels = [f.mount(settings), f.mount(detail)]
  await flush()
  for (const panel of panels) { assertMinimal(panel.render()); copyButton(panel.tree); switchIn(panel.tree) }
  assert.equal(f.calls.length, 2)
  assertStatusOnly(f)
  assert.deepEqual(f.copies, [], 'mount must not copy or install')
  assert.deepEqual(f.writes, [])
})

test('optional configuration stays collapsed and opening it never probes or installs', async t => {
  const f = fixture(t), panel = f.panel()
  await flush(); panel.render()
  assert.equal(section(panel.tree).props.open, false)
  section(panel.tree).props.onToggle({ currentTarget: { open: true } })
  panel.render()
  assert.equal(section(panel.tree).props.open, true)
  assert.deepEqual(f.copies, [])
  assert.deepEqual(f.writes, [])
  assertStatusOnly(f)
})

for (const [enabled, phase, flag, expected] of [[true, 'ready', true, 1], [true, 'ready', false, 0], [true, 'ready', 'true', 0], [false, 'disabled', true, 0], [true, 'preparing', true, 0], [true, 'error', true, 0]]) {
  test(`dependency notice is conditional: enabled=${enabled}, phase=${phase}, flag=${String(flag)}`, async t => {
    const f = fixture(t, { status: { ...status(), enabled, runtime: { phase }, optionalTools: { missingDependency: flag, message: SECRET } } }), panel = f.panel()
    await flush(); panel.render()
    assert.equal(nodes(panel.tree, node => node.props?.['data-rea-dependency-hint']).length, expected)
    assert.equal(section(panel.tree).props.open, false, 'a hint must not auto-expand configuration')
    assert.ok(!text(panel.tree).includes(SECRET))
    assert.deepEqual(f.copies, [])
    assertStatusOnly(f)
  })
}

test('settings explain both tool exposure directions and give conditional model-schema advice', async t => {
  const f = fixture(t), panel = f.panel()
  await flush(); panel.render()
  const impact = text(one(panel.tree, node => node.props?.['data-rea-toggle-impact']))
  assert.match(impact, /按下方勾选的工具族注册/)
  assert.match(impact, /从后续模型请求中移除 REA 工具定义/)
  assert.match(impact, /已安装环境保留/)
  const note = one(panel.tree, node => node.props?.['data-rea-model-impact'])
  assert.match(text(note), /当模型因工具集合过大.*先用自动模式/)
  assert.match(text(note), /Kimi \/ Moonshot/)
  assert.match(text(note), /DeepSeek（strict 模式）/)
  assert.match(text(note), /GPT 系列（OpenAI strict 工具模式）/)
  assert.match(text(note), /不会因接口错误自动关闭 REA/)
  assert.equal(nodes(note, node => node.type === 'a').length, 2)
  assertStatusOnly(f)
})

function mountRuntimeVersions(f, panel) {
  return f.mount(one(panel.tree, node => node.type?.name === 'RuntimeVersions'))
}

test('settings switch refuses to disable REA while a tool call is running', async t => {
  const busy = { ...status(), mode: 'auto', activity: { inflight: 2, tools: ['mcp__rea__open_binary'] } }
  const f = fixture(t, { status: busy }), panel = f.panel()
  await flush(); panel.render()
  assert.equal(nodes(panel.tree, node => node.props?.['data-rea-call-lock']).length, 1)
  assert.match(text(one(panel.tree, node => node.props?.['data-rea-call-lock'])), /正在处理 2 个工具调用/)
  const toggle = switchIn(panel.tree)
  assert.equal(toggle.props['aria-disabled'], true)
  assert.match(toggle.props.title, /完成后再关闭/)
  toggle.props.onClick()
  await flush(); panel.render()
  assert.equal(f.calls.filter(call => call.endpoint === 'reaComponents/setMode').length, 0)
  assert.match(alerts(panel.tree), /正在处理工具调用.*完成后再关闭/)
  assert.deepEqual(f.writes, [])
  assertStatusOnly(f)
})

test('the panel renders English through the host locale and registers both dictionaries', async t => {
  const f = fixture(t), panel = f.panel()
  await flush(); panel.render()
  assert.equal(f.dictionaries.length, 1)
  const entry = f.dictionaries[0]
  assert.equal(entry.namespace, 'dshReakit')
  assert.ok(Object.keys(entry.messages.en).length > 90, 'English dictionary is populated')
  assert.ok(Object.keys(entry.messages.zh).length === Object.keys(entry.messages.en).length, 'both locales cover every key')
  for (const [key, value] of Object.entries(entry.messages.zh)) assert.equal(value, key, 'Chinese dictionary maps each key to itself')
  const english = (key, vars) => {
    const text = entry.messages.en[key] ?? key
    return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : text
  }
  const translated = f.mount(f.element('dsh-reakit'))
  translated.render({ t: english })
  await flush()
  translated.render({ t: english })
  const body = text(translated.tree)
  assert.match(body, /REA settings/)
  assert.match(body, /REA tool switch/)
  assert.match(body, /Optional tool setup/)
  assert.doesNotMatch(body, /REA 工具总开关|可选工具配置/)
})

test('runtime versions stay collapsed and never check on mount, expand, focus or polling', async t => {
  const f = fixture(t), panel = f.panel()
  await flush(); panel.render()
  const versions = mountRuntimeVersions(f, panel), details = one(versions.tree, node => node.props?.['data-rea-runtime-versions'])
  assert.equal(details.props.open, false)
  details.props.onToggle({ currentTarget: { open: true } }); versions.render()
  assert.equal(one(versions.tree, node => node.props?.['data-rea-runtime-versions']).props.open, true)
  f.fire('focus'); f.tick(); await flush()
  assertStatusOnly(f)
  assert.equal(f.calls.filter(call => call.endpoint === 'reaComponents/checkRuntimeUpdates').length, 0)
})

test('only the update button checks metadata; preparation requires both explicit confirmations', async t => {
  const versionResult = {
    phase: 'checked', token: 'candidate-token', updateAvailable: true,
    candidate: {
      rea: { version: '6.10.0', nodeRange: '>=24.22.1', integrity: 'sha512-review', source: 'https://www.npmjs.com/package/rea-agents/v/6.10.0' },
      node: { version: '26.13.0', lts: 'Krypton', source: 'https://nodejs.org/dist/v26.13.0/', archive: { sha256: 'a'.repeat(64) } }, platform: 'darwin', arch: 'arm64',
    },
  }
  const f = fixture(t, { versionResult }), panel = f.panel()
  await flush(); panel.render()
  const versions = mountRuntimeVersions(f, panel)
  one(versions.tree, node => node.type === 'button' && text(node) === '检查更新').props.onClick()
  await flush(); panel.render(); versions.render(one(panel.tree, node => node.type?.name === 'RuntimeVersions').props)
  assert.equal(f.calls.filter(call => call.endpoint === 'reaComponents/checkRuntimeUpdates').length, 1)
  assert.match(text(versions.tree), /REA 6\.9\.0/)
  assert.match(text(versions.tree), /Node 26\.13\.0/)
  const prepare = () => one(versions.tree, node => node.type === 'button' && text(node) === '准备并升级到此版本')
  assert.equal(prepare().props.disabled, true)
  const checkboxes = nodes(versions.tree, node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkboxes.length, 2)
  checkboxes[0].props.onChange({ target: { checked: true } }); versions.render()
  assert.equal(prepare().props.disabled, true)
  checkboxes[1].props.onChange({ target: { checked: true } }); versions.render()
  assert.equal(prepare().props.disabled, false)
  prepare().props.onClick(); await flush()
  const writes = f.calls.filter(call => call.endpoint === 'reaComponents/prepareRuntimeSwitch')
  assert.equal(writes.length, 1)
  assert.deepEqual(plain(writes[0].payload), { args: { token: 'candidate-token', confirmation: { confirmed: true, exported: true } } })
  assert.deepEqual(f.copies, [])
})

test.skip('runtime rollback was removed; version management only moves forward', async t => {
  const initial = { ...status(), runtimeVersions: { phase: 'ready', candidate: null, transition: { state: 'ready', from: { reaVersion: '6.9.0', nodeVersion: 'v24.22.1' }, to: { reaVersion: '6.10.0', nodeVersion: 'v26.13.0' }, rollbackAvailable: true } } }
  const f = fixture(t, { status: initial }), panel = f.panel()
  await flush(); panel.render()
  const versions = mountRuntimeVersions(f, panel)
  assert.equal(one(versions.tree, node => node.props?.['data-rea-runtime-versions']).props.open, false)
  const checkboxes = nodes(versions.tree, node => node.type === 'input' && node.props.type === 'checkbox')
  checkboxes.forEach(box => box.props.onChange({ target: { checked: true } })); versions.render()
  const button = one(versions.tree, node => node.type === 'button' && text(node) === '回退到之前的版本')
  assert.equal(button.props.disabled, false)
  button.props.onClick(); await flush()
  const writes = f.calls.filter(call => call.endpoint === 'reaComponents/rollbackRuntime')
  assert.equal(writes.length, 1)
  assert.deepEqual(plain(writes[0].payload), { args: { confirmation: { confirmed: true, exported: true } } })
})

function mountToggle(f) {
  const owner = f.mount(f.element('dsh-reakit.quick-toggle'))
  return { owner, control: null, render() { const element = owner.render(); if (!this.control) this.control = f.mount(element); else this.control.render(element.props); return this.control.tree } }
}

test('settings and composer switch synchronize the same accepted global state both ways', async t => {
  const f = fixture(t, { status: { ...status(), mode: 'auto' } }), panel = f.panel(), toggle = mountToggle(f)
  await flush(); panel.render(); toggle.render()
  switchIn(toggle.control.tree).props.onClick()
  await flush(); panel.render(); toggle.render()
  assert.equal(switchIn(panel.tree).props['aria-checked'], false)
  assert.equal(switchIn(toggle.control.tree).props['aria-checked'], false)
  switchIn(panel.tree).props.onClick()
  await flush(); panel.render(); toggle.render()
  assert.equal(switchIn(panel.tree).props['aria-checked'], true)
  assert.equal(switchIn(toggle.control.tree).props['aria-checked'], true)
  assert.deepEqual(f.calls.filter(call => call.endpoint === 'reaComponents/setMode').map(call => call.payload.args.mode), ['off', 'manual'])
  assert.deepEqual(f.writes, [])
})

test('cross-window notifications refresh host snapshots and close channels on unmount', async t => {
  const channels = new Set(), messages = []
  class Channel extends EventTarget {
    constructor(name) { super(); this.name = name; channels.add(this) }
    postMessage(data) { messages.push(data); for (const channel of channels) if (channel !== this && channel.name === this.name) channel.dispatchEvent(new MessageEvent('message', { data })) }
    close() { channels.delete(this) }
  }
  const host = { current: { ...status(), mode: 'auto' } }, a = fixture(t, { host, BroadcastChannel: Channel }), b = fixture(t, { host, BroadcastChannel: Channel })
  const toggle = mountToggle(a), panel = b.panel()
  await flush(); toggle.render(); panel.render()
  switchIn(toggle.control.tree).props.onClick()
  await flush(); toggle.render(); panel.render()
  assert.equal(switchIn(panel.tree).props['aria-checked'], false)
  switchIn(panel.tree).props.onClick()
  await flush(); toggle.render(); panel.render()
  assert.equal(switchIn(toggle.control.tree).props['aria-checked'], true)
  assert.deepEqual(messages, ['refresh', 'refresh'])
  assert.deepEqual(a.writes, []); assert.deepEqual(b.writes, [])
  a.dispose(); b.dispose()
  assert.equal(channels.size, 0)
})

test('copy is opt-in, writes the static secret-free prompt once, and reports success only after completion', async t => {
  let resolve
  const pending = new Promise(yes => { resolve = yes })
  const f = fixture(t, { writeText: () => pending }), panel = f.panel()
  await flush(); panel.render()
  const expected = prompt(panel.tree)
  assert.ok(expected.length > 100)
  assert.notEqual(details(panel.tree).props.open, true)
  assert.deepEqual(f.copies, [])
  assert.doesNotMatch(text(panel.tree), /已复制可选工具配置指令/)
  copyButton(panel.tree).props.onClick()
  await flush(); panel.render()
  assert.deepEqual(f.copies, [expected])
  assert.doesNotMatch(text(panel.tree), /已复制可选工具配置指令/, 'pending clipboard write is not success')
  resolve(); await flush(); panel.render()
  assert.match(text(panel.tree), /已复制可选工具配置指令/)
  for (const forbidden of [SECRET, PRIVATE_PATH, '不应使用的动态提示']) assert.ok(!expected.includes(forbidden), `prompt leaked ${forbidden}`)
  f.setStatus(status('another-fixture-secret')); f.fire('focus')
  await flush(); panel.render()
  assert.equal(prompt(panel.tree), expected, 'prompt must not derive from runtime/config/component values')
  assertStatusOnly(f)
  assert.deepEqual(f.writes, [])
})

for (const clipboard of ['rejected', 'missing', 'no-navigator']) {
  test(`clipboard ${clipboard} expands instructions and errors without claiming success`, async t => {
    const f = fixture(t, { clipboard }), panel = f.panel()
    await flush(); panel.render()
    copyButton(panel.tree).props.onClick()
    await flush(); panel.render()
    assert.equal(f.copies.length, clipboard === 'rejected' ? 1 : 0)
    assert.equal(details(panel.tree).props.open, true)
    assert.match(alerts(panel.tree), /复制|剪贴板|clipboard/i)
    assert.doesNotMatch(text(panel.tree), /已复制可选工具配置指令/)
    assert.ok(prompt(panel.tree).length > 100)
    assertStatusOnly(f)
  })
}

test('AI prompt keeps needs-first, read-only, authorization and configuration safety boundaries', async t => {
  const f = fixture(t), panel = f.panel()
  await flush(); panel.render()
  const value = prompt(panel.tree)
  for (const boundary of [/先(?:询问|确认).*(?:用途|分析功能)/, /按需|必[需要]的?依赖/, /先.*只读/, /安装前[\s\S]*明确确认后才执行/, /(?:不要|禁止|不得)全局升级/, /(?:不要|禁止|不得)运行未经审阅的安装脚本/, /(?:不要|禁止|不得)启动[^\n]*(?:目标|进程)[^\n]*设备/, /保留.*配置/, /(?:不要|不得|不)[^\n]*输出[^\n]*凭据/]) {
    assert.match(value, boundary)
  }
  assertStatusOnly(f)
})

test('AI setup is anchored to the installed dsh-reakit plugin, not an upstream REA deployment', async t => {
  const f = fixture(t), panel = f.panel()
  await flush(); panel.render()
  const value = prompt(panel.tree)
  assert.match(value, /^请在 DeepSeek Harness（DSH）中，为我当前已经安装的 dsh-reakit 插件/)
  for (const file of ['README.md', 'package.json', 'lib/config.js', 'lib/bootstrap.js', 'assets/engine/dependencies.lock.json']) assert.ok(value.includes(file), file)
  for (const boundary of [/不是依据 REA 原始仓库.*重新安装 REA/, /不要把原始仓库 main 分支文档.*当作.*安装依据/, /无法定位实例.*先说明并询问/, /复用插件已校验的托管运行时和锁定依赖/, /已有 nodePath \/ reaEntry 手工模式则保留/, /不要另行克隆 REA 仓库、全局安装 rea-agents、运行 npx rea 或 rea setup/, /不要新增独立 REA 服务或其他 MCP 客户端注册项/, /不要改插件锁文件/, /沿用当前实例的 runtimeDir 或手工路径/, /DSH 官方 ConfigEditor.*局部合并/, /保持现有 enabled、autoSetup、nodePath、reaEntry、runtimeDir、serverName/, /通过 DSH 中该 dsh-reakit 实例实际注册的 MCP 工具/, /不要以独立 REA CLI 成功代替插件连接与能力验证/]) assert.match(value, boundary)
  assert.match(text(section(panel.tree)), /基础 Node \/ REA 由插件管理.*仅在所用功能确实缺少外部依赖时配置/)
  assert.match(value, /不要扫描全部可选组件/)
  assert.match(value, /若本次没有明确的缺失项，先询问需要的分析功能/)
  assertStatusOnly(f)
})

test('AI instructions preserve disabled REA and never enable it to prepare or verify dependencies', async t => {
  const disabled = { ...status(), enabled: false, runtime: { phase: 'disabled' } }
  const f = fixture(t, { status: disabled }), panel = f.panel()
  await flush(); panel.render()
  const value = prompt(panel.tree)
  assert.match(value, /处于关闭状态时不得为了安装或验证擅自开启/)
  assert.match(value, /提示导出未保存证据并取得确认/)
  assert.match(value, /状态无法确认时先停下/)
  assert.match(value, /REA 关闭.*明确标为待验证/)
  copyButton(panel.tree).props.onClick()
  await flush(); panel.render()
  assert.deepEqual(f.copies, [value])
  assert.equal(switchIn(panel.tree).props['aria-checked'], false)
  assertStatusOnly(f)
  assert.deepEqual(f.writes, [])
})

test('remaining panel toggle and visibility preference retain their independent writes', async t => {
  const f = fixture(t, { status: { ...status(), mode: 'auto' } }), panel = f.panel()
  await flush(); panel.render()
  switchIn(panel.tree).props.onClick()
  await flush(); panel.render()
  const writes = f.calls.filter(call => call.endpoint !== 'reaComponents/status')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].endpoint, 'reaComponents/setMode')
  assert.deepEqual(plain(writes[0].payload), { args: { mode: 'off' } })
  assert.equal(switchIn(panel.tree).props['aria-checked'], false)
  assert.doesNotMatch(text(panel.tree), /fixture saved|已提交关闭/, 'accepted state replaces transient toggle notices')
  const preference = f.mount(one(panel.tree, node => typeof node.type === 'function' && node.props.form === f.form))
  const checkbox = one(preference.tree, node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkbox.props.checked, true)
  const count = f.calls.length
  checkbox.props.onChange({ target: { checked: false } })
  await flush(); preference.render()
  assert.deepEqual(f.writes, [['showComposerToggle', false]])
  assert.equal(one(preference.tree, node => node.type === 'input').props.checked, false)
  assert.equal(f.calls.length, count, 'display preference must not call REA RPCs')
  assert.equal(f.registrations.filter(item => item.id === 'dsh-reakit.quick-toggle' && item.name === 'conversation.input.left').length, 1)
  assert.deepEqual(f.copies, [])
})

test('Panel polls only status and unmount cancels timers, listeners and its request lifetime', async t => {
  const f = fixture(t), panel = f.panel()
  await flush(); panel.render()
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 1)
  f.tick(); await flush()
  f.fire('focus'); await flush()
  f.fire(CONFIG_CHANGED); await flush()
  assert.equal(f.calls.length, 4)
  assertStatusOnly(f)
  const signals = f.calls.map(call => call.signal), stale = [...f.timers.values()]
  assert.ok(signals.every(signal => signal && !signal.aborted))
  panel.unmount()
  assert.ok(signals.every(signal => signal.aborted))
  assert.equal(f.timers.size, 0)
  assert.ok([...f.listeners.values()].every(set => set.size === 0))
  f.fire('focus'); f.fire(CONFIG_CHANGED); stale.forEach(timer => timer.callback())
  await flush()
  assert.equal(f.calls.length, 4)
  assert.equal(panel.lateUpdates, 0)
})

test('unmount during initial status read suppresses late state and polling', async t => {
  let resolve
  const pending = new Promise(yes => { resolve = yes }), f = fixture(t, { status: pending }), panel = f.panel()
  await flush()
  assert.equal(f.calls.length, 1)
  panel.unmount(); resolve(status())
  await flush()
  assert.equal(panel.lateUpdates, 0)
  assert.equal(f.timers.size, 0)
  assertStatusOnly(f)
  assert.deepEqual(f.copies, [])
})
