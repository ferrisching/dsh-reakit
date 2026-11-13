import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CORE_FAMILIES, MOBILE_FAMILIES, WEB_FAMILIES, ROUTING_MODEL,
  planFamilies, parseClassifierAnswer,
} from '../lib/tool-routing.js'
import { TOOL_FAMILY_IDS } from '../lib/config.js'

test('the routing tables only name published families', () => {
  const published = new Set(TOOL_FAMILY_IDS)
  for (const id of [...CORE_FAMILIES, ...MOBILE_FAMILIES, ...WEB_FAMILIES]) {
    assert.equal(published.has(id), true, `${id} is not a REA family`)
  }
  // every family is reachable: either always on, or behind a signal
  assert.equal(new Set([...CORE_FAMILIES, ...MOBILE_FAMILIES, ...WEB_FAMILIES]).size, TOOL_FAMILY_IDS.length)
  assert.equal(ROUTING_MODEL.model, 'deepseek-flash')
})

test('a task with no signal gets the core families only', () => {
  const plan = planFamilies({ message: '帮我看一下这个 Mach-O 的加载流程' })
  assert.equal(plan.source, 'default')
  assert.deepEqual(plan.families, [...CORE_FAMILIES])
  for (const id of [...MOBILE_FAMILIES, ...WEB_FAMILIES]) assert.equal(plan.families.includes(id), false)
})

test('mobile signals open the mobile families', () => {
  for (const message of ['分析这个 APK 的 JNI 绑定', '用 adb 把包拉下来', 'hook 一下这个方法', '解一下 flutter 的 AOT']) {
    const plan = planFamilies({ message })
    assert.equal(plan.source, 'signal', message)
    for (const id of MOBILE_FAMILIES) assert.equal(plan.families.includes(id), true, `${id} for ${message}`)
    for (const id of CORE_FAMILIES) assert.equal(plan.families.includes(id), true)
  }
})

test('web signals open the web families', () => {
  for (const message of ['看看这个网页的 bundle', '分析 Electron 应用', '抓一下 chrome 的网络请求']) {
    const plan = planFamilies({ message })
    assert.equal(plan.source, 'signal', message)
    for (const id of WEB_FAMILIES) assert.equal(plan.families.includes(id), true, message)
  }
})

test('a task that mentions both groups opens both', () => {
  const plan = planFamilies({ message: '对比 Android APK 和它的 WebView 前端' })
  for (const id of [...MOBILE_FAMILIES, ...WEB_FAMILIES]) assert.equal(plan.families.includes(id), true, id)
  assert.match(plan.reason, /移动端/)
  assert.match(plan.reason, /Web/)
})

test('an explicit manual selection always wins', () => {
  const plan = planFamilies({
    message: '分析 APK',
    config: { toolFamilies: ['native'] },
  })
  assert.equal(plan.source, 'manual')
  assert.deepEqual(plan.families, ['native'])
})

test('a classifier answer narrows nothing but adds the families it names', () => {
  const plan = planFamilies({
    message: '分析这个 APK',
    classify: () => ['android', 'frida'],
  })
  assert.equal(plan.source, 'classify')
  for (const id of CORE_FAMILIES) assert.equal(plan.families.includes(id), true)
  assert.equal(plan.families.includes('android'), true)
  assert.equal(plan.families.includes('frida'), true)
  // the classifier can only add, so a terse answer never removes core coverage
  assert.equal(plan.families.includes('session'), true)
})

test('a broken classifier falls back to the signal rules', () => {
  assert.equal(planFamilies({ message: '分析 APK', classify: () => { throw new Error('model down') } }).source, 'signal')
  assert.equal(planFamilies({ message: '分析 APK', classify: () => null }).source, 'signal')
  assert.equal(planFamilies({ message: '分析 APK', classify: () => [] }).source, 'signal')
})

test('unknown ids are dropped instead of reaching REA', () => {
  const plan = planFamilies({ message: 'hi', classify: () => ['android', 'nope', 'browser'] })
  assert.deepEqual(plan.families.sort(), [...CORE_FAMILIES, 'android', 'browser'].sort())
  // a known-families guard also filters manual input
  const manual = planFamilies({ message: '', config: { toolFamilies: ['native', 'bogus'] } })
  assert.deepEqual(manual.families, ['native'])
})

test('a widened scope does not persist into an unrelated task', () => {
  const previous = [...CORE_FAMILIES, ...MOBILE_FAMILIES]
  const plan = planFamilies({ message: '看看这个二进制', current: previous })
  assert.deepEqual(plan.families, [...CORE_FAMILIES])
})

test('classifier answers are parsed defensively', () => {
  assert.deepEqual(parseClassifierAnswer('android, frida', TOOL_FAMILY_IDS), ['android', 'frida'])
  assert.deepEqual(parseClassifierAnswer('ANDROID\nfrida', TOOL_FAMILY_IDS), ['android', 'frida'])
  assert.deepEqual(parseClassifierAnswer('android android', TOOL_FAMILY_IDS), ['android'])
  assert.equal(parseClassifierAnswer('linux', TOOL_FAMILY_IDS), null)
  assert.equal(parseClassifierAnswer('', TOOL_FAMILY_IDS), null)
  assert.equal(parseClassifierAnswer(null, TOOL_FAMILY_IDS), null)
  assert.deepEqual(parseClassifierAnswer('`android`', TOOL_FAMILY_IDS), ['android'])
})
