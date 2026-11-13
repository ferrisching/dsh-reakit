import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
const CONFIG_CHANGED = 'dsh-reakit:configuration-changed'
const ENTRY_ID = 'owned-rea-settings-entry'
const flush = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function status(overrides = {}) {
  return { settingsEntryId: ENTRY_ID, enabled: true, configurationWritable: true, runtime: { phase: 'ready' }, ...overrides }
}

function preference(visible, writable = true, phase = 'ready') {
  return Object.freeze({ status: phase, writable, value: Object.freeze({ showComposerToggle: visible }) })
}

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

const switchIn = tree => one(tree, node => node.type === 'button' && node.props?.role === 'switch')
// The button carries an aria-hidden status dot alongside its text label.
const labelOf = button => button.children.filter(child => typeof child === 'string').join('')
const dotOf = button => button.children.find(child => child && typeof child === 'object' && child.props?.['data-rea-dot'])?.props['data-rea-dot']
const checkboxIn = tree => one(tree, node => node.type === 'input' && node.props?.type === 'checkbox')
const alertsIn = tree => nodes(tree, node => node.props?.role === 'alert').map(node => node.children.join('')).join('\n')

// Deliberately not a React reconciler: each function component has persistent
// hook slots and an explicit render/commit/unmount cycle. Tests decide when to
// re-render; refs still update synchronously between two calls to an old handler.
function hookHarness() {
  let active
  const frames = new Set()
  const slot = kind => {
    assert.ok(active, `${kind} must be called while rendering`)
    const index = active.cursor++
    let hook = active.hooks[index]
    if (!hook) active.hooks[index] = hook = { kind, initialized: false }
    assert.equal(hook.kind, kind, 'hook order must remain stable')
    return hook
  }
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const frame = active, hook = slot('state'), ordinal = frame.stateCursor++
      if (!hook.initialized) {
        hook.value = ordinal < frame.seedStates.length ? frame.seedStates[ordinal] : typeof initial === 'function' ? initial() : initial
        hook.initialized = true
      }
      return [hook.value, next => {
        frame.updates++
        if (!frame.mounted) frame.lateUpdates++
        hook.value = typeof next === 'function' ? next(hook.value) : next
      }]
    },
    useRef(initial) {
      const hook = slot('ref')
      if (!hook.initialized) { hook.value = { current: initial }; hook.initialized = true }
      return hook.value
    },
    useMemo(factory, dependencies) {
      const hook = slot('memo')
      if (!hook.initialized || !same(hook.dependencies, dependencies)) {
        hook.value = factory(); hook.dependencies = dependencies; hook.initialized = true
      }
      return hook.value
    },
    useEffect(callback, dependencies) {
      const frame = active, hook = slot('effect')
      if (!hook.initialized || !same(hook.dependencies, dependencies)) {
        frame.effects.push(() => { hook.cleanup?.(); hook.cleanup = callback() })
        hook.dependencies = dependencies; hook.initialized = true
      }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const frame = active, hook = slot('store')
      if (!hook.initialized || hook.subscribe !== subscribe) {
        frame.effects.push(() => {
          hook.cleanup?.()
          hook.cleanup = subscribe(() => { frame.notifications++ })
        })
        hook.subscribe = subscribe; hook.initialized = true
      }
      return getSnapshot()
    },
  }
  function mount(element, { seedStates = [], effects = true } = {}) {
    assert.equal(typeof element.type, 'function')
    const frame = {
      hooks: [], effects: [], cursor: 0, stateCursor: 0, seedStates, mounted: true,
      updates: 0, lateUpdates: 0, notifications: 0, props: element.props, tree: null,
      render(props = frame.props) {
        assert.ok(frame.mounted, 'cannot render an unmounted component')
        frame.cursor = 0; frame.stateCursor = 0; frame.props = props; active = frame
        try { frame.tree = element.type(props) } finally { active = undefined }
        const pendingEffects = frame.effects.splice(0)
        if (effects) pendingEffects.forEach(commit => commit())
        return frame.tree
      },
      unmount() {
        if (!frame.mounted) return
        frame.mounted = false
        frame.hooks.forEach(hook => hook.cleanup?.())
      },
    }
    frames.add(frame); frame.render()
    return frame
  }
  return { react, mount, dispose: () => frames.forEach(frame => frame.unmount()) }
}

function fixture(t, options = {}) {
  const hooks = hookHarness(), timers = new Map(), listeners = new Map(), broadcasts = []
  const target = new EventTarget(), calls = [], gets = [], sets = [], subscribers = new Set()
  let nextTimer = 0, currentStatus = options.status || status(), snapshot = options.preference || preference(true)
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) },
    async set(key, value) {
      sets.push([key, value])
      const accepted = options.formSet ? await options.formSet(key, value) : true
      if (accepted) publish(preference(value, snapshot.writable))
      return accepted
    },
  }
  function publish(next) { snapshot = next; subscribers.forEach(listener => listener()) }
  const window = {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener); target.addEventListener(name, listener)
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); target.removeEventListener(name, listener) },
    dispatchEvent(event) { broadcasts.push(event.type); return target.dispatchEvent(event) },
    __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, 'dsh-reakit')
      exported = factory(name => { assert.equal(name, 'react'); return hooks.react })
    } },
  }
  let exported
  // Minimal document head: the indicator stylesheet is the only DOM write.
  const styleSheets = []
  const head = { appendChild(node) { styleSheets.push(node) } }
  const document = {
    head,
    getElementById(id) { return styleSheets.find(node => node.id === id) || null },
    createElement(tag) { assert.equal(tag, 'style'); return { id: '', tagName: 'STYLE', textContent: '' } },
  }
  // No browser, fetch, Node require, real timers, or configuration service is
  // exposed to the client. Every RPC and config-form access is local to this VM.
  vm.runInNewContext(source, {
    window, Event, AbortController, document,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
  }, { filename: 'dsh-reakit/client/client.js' })
  const activity = { options: { name: 'conversation.composer.dock', id: 'activity' }, render: () => 'activity' }
  const usage = { options: { name: 'conversation.composer.dock', id: 'usage' }, render: () => 'usage' }
  const registrations = [activity, usage, ...(options.existingEntries || [])], injections = []
  exported.apply({
    slots: {
      inject(name, callback) { injections.push(name); return callback() },
      register(registration, render) {
        assert.ok(!registrations.some(item => item.options.name === registration.name && item.options.id === registration.id), 'slot registration must not replace an existing id')
        registrations.push({ options: registration, render })
      },
    },
    configForms: { get(id) { gets.push(id); assert.equal(id, ENTRY_ID); return form } },
    connection: { rpc: { async call(channel, endpoint, payload, signal) {
      calls.push({ channel, endpoint, payload, signal })
      assert.equal(channel, '/api')
      if (endpoint === 'reaComponents/status') {
        const value = await currentStatus
        if (value instanceof Error) throw value
        return { ok: true, value }
      }
      if (endpoint === 'reaComponents/setMode') {
        if (options.setMode) return options.setMode(payload.args, signal)
        const mode = payload.args.mode
        currentStatus = { ...currentStatus, enabled: mode !== 'off', toolRouting: mode === 'off' ? currentStatus.toolRouting : mode, mode }
        return { ok: true, value: { message: 'saved', mode } }
      }
      assert.fail(`unexpected RPC: ${endpoint}; dock and preference must never describe or probe components`)
    } } },
  })
  const registration = id => {
    const matches = registrations.filter(item => item.options.id === id)
    assert.equal(matches.length, 1)
    return matches[0]
  }
  function dock(props = {}) {
    const owner = hooks.mount(registration('dsh-reakit.quick-toggle').render(props))
    let control
    return {
      owner, initial: owner.tree,
      get control() { return control },
      render() {
        const element = owner.render()
        if (!element) { control?.unmount(); control = undefined; return null }
        if (!control) control = hooks.mount(element)
        else control.render(element.props)
        return control.tree
      },
      unmount() { control?.unmount(); owner.unmount() },
    }
  }
  function settingsPanel() {
    // Seed the already-read view; skip only unrelated describe/polling effects.
    return hooks.mount(registration('dsh-reakit').render({}), {
      seedStates: [{ ...status(), ...currentStatus, components: [] }], effects: false,
    })
  }
  function composerPreference() {
    // Reach the private preference through the real settings slot. Its own
    // hooks/effects run normally, unlike the parent Panel's unrelated polling.
    const panel = settingsPanel()
    const element = one(panel.tree, node => typeof node.type === 'function' && node.props?.form === form)
    return hooks.mount(element)
  }
  const result = {
    exported, registrations, injections, activity, usage, calls, gets, sets, timers, listeners, broadcasts, subscribers, styleSheets,
    form, dock, settingsPanel, composerPreference, publish,
    setStatus: next => { currentStatus = next },
    fire: name => target.dispatchEvent(new Event(name)),
    tick() {
      const pending = [...timers.entries()]
      pending.forEach(([id, timer]) => { timers.delete(id); timer.callback() })
    },
    dispose: hooks.dispose,
  }
  t.after(result.dispose)
  return result
}

function assertNoGlobalWrites(f) {
  assert.equal(f.calls.filter(call => call.endpoint !== 'reaComponents/status').length, 0)
}

test('quick-toggle registers one unique toolbar action and leaves the statistics dock untouched', t => {
  const f = fixture(t)
  assert.equal(f.registrations[0], f.activity)
  assert.equal(f.registrations[1], f.usage)
  assert.equal(f.activity.render(), 'activity')
  assert.equal(f.usage.render(), 'usage')
  assert.deepEqual(f.registrations.slice(2).map(item => [item.options.name, item.options.id]), [
    ['plugins.detail.section', 'dsh-reakit.components'],
    ['settings.section', 'dsh-reakit'],
    ['conversation.input.left', 'dsh-reakit.quick-toggle'],
  ])
  assert.deepEqual(f.injections, ['plugins.detail.section', 'settings.section', 'conversation.input.left'])
  assert.deepEqual(f.registrations.filter(item => item.options.name === 'conversation.composer.dock'), [f.activity, f.usage])
  assert.equal(f.registrations.filter(item => item.options.name === 'conversation.input.left').length, 1)
  assert.ok(f.exported.inject.includes('configForms'))
  assert.equal(f.calls.length, 0)
  assert.equal(f.gets.length, 0)
})

test('toolbar switch stays compact without host layout patches or floating positioning', async t => {
  const f = fixture(t), toolbar = f.dock()
  await flush()
  const tree = toolbar.render(), button = switchIn(tree)
  assert.equal(tree.props['data-rea-quick-toggle'], true)
  assert.equal(button.props.style.fontSize, '12px')
  assert.equal(button.props.style.lineHeight, '16px')
  assert.equal(button.props.style.height, '28px')
  assert.equal(button.props.style.minHeight, '28px')
  assert.equal(button.props.style.minWidth, '56px')
  assert.equal(button.props.style.padding, '0 8px')
  assert.equal(button.props.style.borderRadius, '14px')
  assert.equal(button.props.style.border, 'none')
  assert.equal(button.props.style.whiteSpace, 'nowrap')
  assert.match(button.props.style.background, /var\(--dsw-alias-button-ghost-active-fill, transparent\)/)
  assert.match(button.props.style.boxShadow, /var\(--dsw-alias-button-ghost-active-border, currentColor\)/)
  for (const node of nodes(tree, () => true)) {
    assert.notEqual(node.type, 'style')
    assert.ok(!node.props.style?.position || node.props.style.position === 'static')
    assert.equal(node.props.style?.transform, undefined)
  }
  assert.deepEqual(f.sets, [])
  assertNoGlobalWrites(f)
})

for (const present of [false, true]) {
  test(`native tools entry remains independent with optional GenUI button present=${present}`, async t => {
    const genui = { options: { name: 'conversation.input.left', id: 'genui-prompt-toggle', order: 0 }, render: () => '标准' }
    const f = fixture(t, { existingEntries: present ? [genui] : [] }), toolbar = f.dock()
    await flush()
    assert.ok(switchIn(toolbar.render()))
    const entries = f.registrations.filter(item => item.options.name === 'conversation.input.left')
    assert.equal(entries.length, present ? 2 : 1)
    const own = entries.find(item => item.options.id === 'dsh-reakit.quick-toggle')
    assert.ok(own)
    assert.ok(own.options.order > genui.options.order)
    if (present) { assert.equal(entries[0], genui); assert.equal(genui.render(), '标准') }
    assert.equal(f.registrations.filter(item => item.options.name === 'conversation.input.right').length, 0)
    assert.deepEqual(f.sets, [])
    assertNoGlobalWrites(f)
  })
}

for (const [enabled, phase, short, full] of [[false, 'disabled', 'REA 关', '已关闭'], [true, 'ready', 'REA 手动', '已就绪'], [true, 'preparing', 'REA…', '启动中'], [true, 'error', 'REA !', '连接失败']]) {
  test(`compact label keeps full accessible status for enabled=${enabled}, phase=${phase}`, async t => {
    const f = fixture(t, { status: status({ enabled, runtime: { phase } }) }), toolbar = f.dock()
    await flush()
    const button = switchIn(toolbar.render())
    assert.equal(labelOf(button), short)
    assert.ok(button.props.title.includes(full))
    assert.ok(button.props['aria-description'].includes(full))
    assert.equal(button.props['aria-label'], 'REA 快捷开关')
    assert.equal(button.props['aria-checked'], enabled)
    assertNoGlobalWrites(f)
  })
}

for (const [label, overrides, expectedDot, expectedLabel] of [
  ['disabled runtime', { enabled: false, runtime: { phase: 'disabled' } }, 'off', 'REA 关'],
  ['ready and idle', { runtime: { phase: 'ready' }, activity: { inflight: 0, tools: [] } }, 'ready', 'REA 手动'],
  ['starting', { runtime: { phase: 'preparing' } }, 'pending', 'REA…'],
  ['connection error', { runtime: { phase: 'error' } }, 'error', 'REA !'],
  ['call in flight', { runtime: { phase: 'ready' }, activity: { inflight: 2, tools: ['open_binary'] } }, 'active', 'REA 用'],
]) {
  test(`composer dot reflects ${label}`, async t => {
    const f = fixture(t, { status: status(overrides) }), toolbar = f.dock()
    await flush()
    const button = switchIn(toolbar.render())
    assert.equal(dotOf(button), expectedDot)
    assert.equal(labelOf(button), expectedLabel)
    assert.equal(button.props['aria-busy'], expectedDot === 'active' ? true : undefined)
    if (expectedDot === 'active') assert.match(button.props['aria-description'], /正在处理工具调用.*open_binary/)
    assertNoGlobalWrites(f)
  })
}

test('short calls are still made visible: fast cadence while armed, one-shot ripple when missed', async t => {
  const f = fixture(t, { status: status({ runtime: { phase: 'ready' }, activity: { inflight: 0, tools: [], lastCompletedAt: Date.now() - 500 } }) })
  const fresh = f.dock()
  await flush()
  const button = switchIn(fresh.render())
  assert.equal(dotOf(button), 'recent', 'a just-finished call is marked')
  const styles = f.styleSheets[0].textContent
  assert.match(styles, /dsh-reakit-flash/, 'recent state carries a one-shot ripple')
  assert.match(styles, /prefers-reduced-motion:reduce[^}]*\}[^@]*recent/, 'the ripple is disabled for reduced motion')
})

test('a call that finished between polls is acknowledged briefly, not shown as running', async t => {
  const recent = fixture(t, { status: status({ runtime: { phase: 'ready' }, activity: { inflight: 0, tools: [], lastCompletedAt: Date.now() - 1000 } }) }), toolbar = recent.dock()
  await flush()
  const button = switchIn(toolbar.render())
  assert.equal(dotOf(button), 'recent')
  assert.equal(labelOf(button), 'REA 手动')
  assert.match(button.props['aria-description'], /刚刚调用过/)
  assert.equal(button.props['aria-busy'], undefined, 'a finished call is not busy')
  const stale = fixture(t, { status: status({ runtime: { phase: 'ready' }, activity: { inflight: 0, tools: [], lastCompletedAt: Date.now() - 60000 } }) }), staleToolbar = stale.dock()
  await flush()
  assert.equal(dotOf(switchIn(staleToolbar.render())), 'ready')
})

test('composer refuses to disable REA while a tool call is running', async t => {
  const f = fixture(t, { status: status({ mode: 'auto', runtime: { phase: 'ready' }, activity: { inflight: 1, tools: ['mcp__rea__open_binary'] } }) }), toolbar = f.dock()
  await flush()
  const button = switchIn(toolbar.render())
  assert.equal(button.props['aria-disabled'], true)
  assert.equal(button.props.disabled, false, 'the control stays focusable so it can explain itself')
  assert.match(button.props.title, /完成后再关闭/)
  button.props.onClick()
  await flush()
  assert.equal(f.calls.filter(call => call.endpoint === 'reaComponents/setMode').length, 0, 'no disable request may be sent')
  const alert = alertsIn(toolbar.render())
  assert.match(alert, /正在处理工具调用.*完成后再关闭/)
  assertNoGlobalWrites(f)
})

test('call activity never shows as running while REA is disabled or unreachable', async t => {
  for (const overrides of [{ enabled: false, runtime: { phase: 'disabled' }, activity: { inflight: 3, tools: [] } }]) {
    const f = fixture(t, { status: status(overrides) }), toolbar = f.dock()
    await flush()
    assert.equal(dotOf(switchIn(toolbar.render())), 'off')
  }
  const f = fixture(t), toolbar = f.dock()
  await flush(); toolbar.render()
  f.setStatus(new Error('unreachable')); f.fire('focus'); await flush()
  assert.equal(dotOf(switchIn(toolbar.render())), 'unknown')
})

test('indicator styles are installed once outside the dock subtree', async t => {
  const f = fixture(t), dock = f.dock()
  await flush()
  assert.equal(nodes(dock.render(), node => node.type === 'style').length, 0)
  assert.equal(f.styleSheets.filter(entry => entry.id === 'dsh-reakit-indicator-styles').length, 1)
  assert.match(f.styleSheets[0].textContent, /dsh-reakit-pulse/)
  assert.match(f.styleSheets[0].textContent, /prefers-reduced-motion/)
  const second = f.dock()
  await flush(); second.render()
  assert.equal(f.styleSheets.length, 1, 'a second dock must reuse the stylesheet')
})

test('settings typography is compact and panel-scoped without resizing the composer dock', async t => {
  const f = fixture(t)
  const panel = f.settingsPanel()
  assert.equal(panel.tree.props['data-rea-settings'], true)
  assert.equal(panel.tree.props.style.fontSize, '13px')
  assert.equal(panel.tree.props.style.lineHeight, '1.55')
  const css = one(panel.tree, node => node.type === 'style' && node.props['data-rea-panel-style']).children.join('')
  assert.match(css, /h3\{font-size:16px;line-height:24px;/)
  assert.match(css, /h4\{font-size:13px;line-height:20px;/)
  assert.match(css, /p\{margin:6px 0;/)
  assert.match(css, /button,\[data-rea-settings\] input\{font:inherit;/)
  for (const rule of css.split('}').filter(Boolean)) {
    for (const selector of rule.slice(0, rule.indexOf('{')).split(',')) {
      assert.ok(selector.startsWith('[data-rea-settings] '), `unscoped rule: ${selector}`)
    }
  }
  assert.doesNotMatch(css, /!important|zoom:|transform:/)
  const dock = f.dock()
  await flush()
  const tree = dock.render()
  assert.equal(switchIn(tree).props.style.fontSize, '12px')
  assert.equal(nodes(tree, node => node.type === 'style').length, 0)
  assert.deepEqual(f.sets, [])
  assertNoGlobalWrites(f)
})

test('dock visibility reads only the accepted snapshot from the same owned config form as settings', async t => {
  const f = fixture(t, { preference: preference(true, true, 'loading') })
  const dock = f.dock()
  assert.equal(dock.initial, null, 'initial status has not been read')
  await flush()
  assert.equal(dock.render(), null, 'loading is hidden even if its value is true')
  const pref = f.composerPreference()
  assert.equal(checkboxIn(pref.tree).props.disabled, true)
  assert.equal(checkboxIn(pref.tree).props.checked, false)
  for (const value of [false, undefined, 'true', 1]) {
    f.publish(preference(value))
    assert.equal(dock.render(), null, `only accepted boolean true is visible, not ${value}`)
  }
  f.publish(preference(true))
  assert.equal(switchIn(dock.render()).props.disabled, false)
  assert.ok(f.gets.length >= 2)
  assert.ok(f.gets.every(id => id === ENTRY_ID))
  assert.ok(pref.notifications > 0 && dock.control.notifications > 0)
  assertNoGlobalWrites(f)
  assert.deepEqual(f.sets, [])
})

test('form writability gates only the preference, while global authorization independently gates the switch', async t => {
  const f = fixture(t, { preference: preference(true, false) })
  const pref = f.composerPreference(), dock = f.dock()
  await flush()
  assert.equal(checkboxIn(pref.tree).props.disabled, true)
  checkboxIn(pref.tree).props.onChange({ target: { checked: false } })
  assert.equal(switchIn(dock.render()).props.disabled, false)
  switchIn(dock.render()).props.onClick()
  await flush()
  assert.equal(f.calls.filter(call => call.endpoint === 'reaComponents/setMode').length, 1)
  assert.deepEqual(f.sets, [], 'global switch must not save a display preference')

  f.publish(preference(true, true))
  f.setStatus(status({ configurationWritable: false }))
  f.fire(CONFIG_CHANGED)
  await flush()
  const disabled = switchIn(dock.render())
  assert.equal(disabled.props.disabled, true)
  disabled.props.onClick()
  assert.equal(checkboxIn(pref.render()).props.disabled, false)
  await flush()
  assert.equal(f.calls.filter(call => call.endpoint === 'reaComponents/setMode').length, 1)
})

for (const enabled of [true, false]) {
  test(`quick switch writes the inverse of enabled=${enabled} once and blocks stale rapid clicks with its pending ref`, async t => {
    const request = deferred(), f = fixture(t, { status: status({ enabled }), setMode: () => request.promise })
    const onInput = () => assert.fail('must not touch composer input')
    const inputProps = Object.freeze({ value: '未发送的输入内容', placeholder: 'existing placeholder', disabled: false, onInput })
    const composerProps = Object.freeze({ inputProps, value: inputProps.value, onInput })
    const before = Object.getOwnPropertyDescriptors(inputProps)
    const dock = f.dock(composerProps)
    await flush()
    const button = switchIn(dock.render())
    assert.equal(button.props['aria-checked'], enabled)
    button.props.onClick(); button.props.onClick(); button.props.onClick()
    await flush()
    assert.equal(switchIn(dock.render()).props.disabled, true)
    button.props.onClick()
    await flush()
    const writes = f.calls.filter(call => call.endpoint === 'reaComponents/setMode')
    assert.equal(writes.length, 1)
    assert.deepEqual(plain(writes[0].payload), { args: { mode: enabled ? 'auto' : 'manual' } })
    assert.deepEqual(f.sets, [])
    assert.equal(f.calls.some(call => call.endpoint.includes('describe')), false)
    assert.equal(nodes(dock.control.tree, node => node.type === 'input' || node.type === 'textarea').length, 0)
    assert.deepEqual(Object.getOwnPropertyDescriptors(inputProps), before)
    assert.equal(composerProps.value, '未发送的输入内容')
    assert.equal(composerProps.onInput, onInput)
    request.resolve({ ok: true, value: { message: 'saved' } })
    await flush()
    assert.equal(switchIn(dock.render()).props.disabled, false)
    assert.equal(f.broadcasts.filter(name => name === CONFIG_CHANGED).length, 1)
  })
}

for (const mode of ['remote-error', 'transport-rejection']) {
  test(`failed switch ${mode} is not retried, broadcasts refresh, and renders its error`, async t => {
    const f = fixture(t, { setMode: () => {
      if (mode === 'transport-rejection') throw new Error('write response interrupted')
      return { ok: false, error: { code: 'gateway/service-unavailable', message: 'configuration write interrupted' } }
    } })
    const dock = f.dock()
    await flush()
    switchIn(dock.render()).props.onClick()
    await flush()
    assert.match(alertsIn(dock.render()), /切换失败：.*interrupted/)
    assert.equal(switchIn(dock.render()).props.disabled, false)
    assert.equal(f.broadcasts.filter(name => name === CONFIG_CHANGED).length, 1)
    assert.ok(f.calls.filter(call => call.endpoint === 'reaComponents/status').length >= 2, 'broadcast must re-read lightweight status')
    f.tick(); f.fire('focus')
    await flush()
    assert.equal(f.calls.filter(call => call.endpoint === 'reaComponents/setMode').length, 1)
    assert.equal(f.calls.some(call => call.endpoint.includes('describe')), false)
    assert.deepEqual(f.sets, [])
  })
}

for (const visible of [true, false]) {
  test(`preference writes only showComposerToggle=${visible} and waits for an accepted snapshot`, async t => {
    const write = deferred(), f = fixture(t, { preference: preference(!visible), formSet: () => write.promise })
    const pref = f.composerPreference(), checkbox = checkboxIn(pref.tree)
    checkbox.props.onChange({ target: { checked: visible } })
    checkbox.props.onChange({ target: { checked: visible } })
    await flush()
    assert.deepEqual(f.sets, [['showComposerToggle', visible]])
    assert.equal(checkboxIn(pref.render()).props.disabled, true)
    assert.equal(checkboxIn(pref.tree).props.checked, !visible, 'not optimistic before acceptance')
    write.resolve(true)
    await flush()
    assert.equal(checkboxIn(pref.render()).props.checked, visible)
    assert.equal(checkboxIn(pref.tree).props.disabled, false)
    assert.equal(alertsIn(pref.tree), '')
    assert.equal(f.calls.length, 0, 'preference must not call REA status, describe, or setEnabled')
    assert.deepEqual(f.broadcasts, [])
  })
}

for (const result of ['false', 'rejection']) {
  test(`preference ${result} does not claim a save or start/stop REA`, async t => {
    const f = fixture(t, { preference: preference(false), formSet: () => {
      if (result === 'rejection') throw new Error('preference write denied')
      return false
    } })
    const pref = f.composerPreference()
    checkboxIn(pref.tree).props.onChange({ target: { checked: true } })
    await flush()
    assert.deepEqual(f.sets, [['showComposerToggle', true]])
    assert.equal(checkboxIn(pref.render()).props.checked, false)
    assert.equal(checkboxIn(pref.tree).props.disabled, false)
    assert.match(alertsIn(pref.tree), result === 'false' ? /未保存/ : /preference write denied/)
    assert.equal(nodes(pref.tree, node => node.props?.role === 'status').length, 0)
    assert.equal(f.calls.length, 0)
    assert.deepEqual(f.broadcasts, [])
  })
}

test('loading or read-only preference rejects even a manually invoked disabled change handler', async t => {
  const f = fixture(t, { preference: preference(false, true, 'loading') })
  const pref = f.composerPreference()
  checkboxIn(pref.tree).props.onChange({ target: { checked: true } })
  f.publish(preference(false, false))
  const checkbox = checkboxIn(pref.render())
  assert.equal(checkbox.props.disabled, true)
  checkbox.props.onChange({ target: { checked: true } })
  await flush()
  assert.deepEqual(f.sets, [])
  assert.equal(f.calls.length, 0)
})

test('unavailable initial status or missing owned settings entry keeps the dock hidden', async t => {
  const f = fixture(t, { status: new Error('status unavailable') }), dock = f.dock()
  assert.equal(dock.initial, null)
  await flush()
  assert.equal(dock.render(), null)
  assert.deepEqual(f.gets, [])
  f.setStatus(status({ settingsEntryId: undefined })); f.fire('focus')
  await flush()
  assert.equal(dock.render(), null)
  assert.deepEqual(f.gets, [])
  assertNoGlobalWrites(f)
})

test('loss of previously available status disables the visible switch until status recovers', async t => {
  const f = fixture(t), dock = f.dock()
  await flush()
  assert.equal(switchIn(dock.render()).props.disabled, false)
  f.setStatus(new Error('status unavailable')); f.fire('focus')
  await flush()
  const button = switchIn(dock.render())
  assert.equal(button.props.disabled, true)
  assert.equal(labelOf(button), 'REA ?')
  assert.match(button.props.title, /状态不可用/)
  assert.match(button.props['aria-description'], /状态不可用/)
  button.props.onClick()
  await flush()
  assertNoGlobalWrites(f)
  f.setStatus(status({ enabled: false })); f.fire('focus')
  await flush()
  assert.equal(switchIn(dock.render()).props.disabled, false)
  assert.equal(switchIn(dock.render()).props['aria-checked'], false)
})

test('dock unmount removes polling, listeners and form subscription, and aborts its status lifetime', async t => {
  const f = fixture(t), dock = f.dock()
  await flush()
  dock.render()
  const signal = f.calls[0].signal, staleTimer = [...f.timers.values()][0]
  assert.equal(signal.aborted, false)
  assert.equal(f.timers.size, 1)
  assert.equal(f.subscribers.size, 1)
  assert.equal(f.listeners.get('focus').size, 1)
  assert.equal(f.listeners.get(CONFIG_CHANGED).size, 1)
  dock.unmount()
  assert.equal(signal.aborted, true)
  assert.equal(f.timers.size, 0)
  assert.equal(f.subscribers.size, 0)
  assert.equal(f.listeners.get('focus').size, 0)
  assert.equal(f.listeners.get(CONFIG_CHANGED).size, 0)
  const reads = f.calls.length
  f.fire('focus'); f.fire(CONFIG_CHANGED); staleTimer.callback()
  await flush()
  assert.equal(f.calls.length, reads)
  assert.equal(dock.owner.lateUpdates, 0)
})

test('unmount while initial status is pending suppresses late state and timer updates', async t => {
  const f = fixture(t), read = deferred()
  f.setStatus(read.promise)
  const dock = f.dock()
  await flush()
  assert.equal(f.calls.length, 1)
  assert.equal(dock.owner.updates, 0, 'the first status read must still be pending')
  dock.unmount()
  read.resolve(status())
  await flush()
  assert.equal(dock.owner.lateUpdates, 0)
  assert.equal(f.timers.size, 0)
})

test('unmounted quick view ignores a late write rejection but still broadcasts configuration refresh', async t => {
  const write = deferred(), f = fixture(t, { setMode: () => write.promise }), dock = f.dock()
  await flush()
  switchIn(dock.render()).props.onClick()
  await flush()
  const control = dock.control
  dock.unmount()
  write.reject(new Error('late write failure'))
  await flush()
  assert.equal(control.lateUpdates, 0)
  assert.equal(dock.owner.lateUpdates, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(f.subscribers.size, 0)
  assert.equal(f.broadcasts.filter(name => name === CONFIG_CHANGED).length, 1)
  assert.equal(f.calls.filter(call => call.endpoint === 'reaComponents/setMode').length, 1)
})

test('unmounted preference unsubscribes and ignores a late rejected save', async t => {
  const write = deferred(), f = fixture(t, { preference: preference(false), formSet: () => write.promise })
  const pref = f.composerPreference()
  checkboxIn(pref.tree).props.onChange({ target: { checked: true } })
  await flush()
  assert.equal(f.subscribers.size, 1)
  pref.unmount()
  assert.equal(f.subscribers.size, 0)
  write.reject(new Error('late preference failure'))
  await flush()
  assert.equal(pref.lateUpdates, 0)
  assert.deepEqual(f.sets, [['showComposerToggle', true]])
  assert.equal(f.calls.length, 0)
})

test('the existing-REA block renders without a host and never throws on missing state', async () => {
  // Regression: this component once referenced a state variable it never declared,
  // which made the whole settings slot crash to a blank pane.
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  let exported
  const calls = []
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useRef: value => ({ current: value }),
    useEffect: () => {},
    useMemo: factory => factory(),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => hooks) } } } }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const rpc = async method => { calls.push(method); return { root: '/r', nodeBytes: 0, engineBytes: 0, legacy: [], blockedBy: [] } }
  const tree = exported.__testing.ExistingRuntime({
    rpc,
    t: key => String(key),
    configurationWritable: true,
    installers: [{ id: 'brew', title: 'Homebrew', command: 'brew install node', note: 'note' }],
    onChanged: () => {},
  })
  const text = JSON.stringify(tree)
  assert.match(text, /本机没有可用的 Node 与 REA/)
  assert.match(text, /brew install node/)
  assert.match(text, /data-rea-install-choice/)
})

test('the tool-scope block renders each family with its scope', async () => {
  // Regression: a helper defined inside one component and used by another made
  // the whole settings pane render nothing.
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  let exported
  const slots = []
  const effects = []
  let cursor = 0
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => {
      const index = cursor++
      if (slots[index] === undefined) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef: value => ({ current: value }),
    useEffect: fn => { effects.push(fn) },
    useMemo: factory => factory(),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => hooks) } } } }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const scope = {
    selected: ['native'],
    total: 255,
    totalBytes: 361055,
    advertisedTools: 37,
    advertisedBytes: 54587,
    families: [
      { id: 'native', tools: 37, bytes: 54587, purpose: '原生二进制与调试：Mach-O/PE/ELF 结构' },
      { id: 'session', tools: 24, bytes: 36055, purpose: '会话与证据：证据导入导出、函数比较' },
    ],
  }
  const props = { rpc: async () => scope, t: key => String(key), configurationWritable: true, onChanged: () => {} }
  // first render resolves the data, the second one draws it
  cursor = 0; effects.length = 0
  exported.__testing.ToolScope(props)
  for (const effect of effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  cursor = 0; effects.length = 0
  const tree = exported.__testing.ToolScope(props)
  const text = JSON.stringify(tree)
  assert.match(text, /native · 37 · 53 KB/)
  assert.match(text, /原生二进制与调试/)
  assert.match(text, /会话与证据/)
  assert.match(text, /data-rea-tool-scope-size/)
})
