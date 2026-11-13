// Task-based tool routing.
//
// The model request pays for every advertised tool schema, and the full REA
// catalogue is large (255 tools, about 353 KB with the compact profile). This
// module decides which tool families a task actually needs. It is a pure
// function: the caller supplies the message, the current selection and the
// configuration, and an optional classifier. Nothing here starts REA, calls a
// model, or touches the profile.

/** Families that are useful for almost every investigation. */
import { TOOL_FAMILY_IDS } from './config.js'

export const CORE_FAMILIES = Object.freeze([
  'direct', 'enhanced', 'native', 'artifact', 'managed', 'firmware', 'pcap', 'session', 'application',
])

/** Mobile work: Android packages, devices and instrumentation. */
export const MOBILE_FAMILIES = Object.freeze(['android', 'adb', 'apktool', 'jeb', 'frida', 'flutter'])

/** Web and JavaScript runtimes. */
export const WEB_FAMILIES = Object.freeze(['browser', 'electron', 'javascript-runtime'])

/**
 * The classifier is a cheap, fixed model so routing never competes with the
 * chat model. `provider` stays unset: DSH resolves the configured provider pair.
 */
export const ROUTING_MODEL = Object.freeze({ model: 'deepseek-flash', purpose: 'tool-routing' })

const MOBILE_SIGNALS = [
  'apk', 'android', '安卓', 'adb', 'jni', 'smali', 'apktool', 'jeb', 'frida', 'hook',
  'flutter', 'dart', '手机', '移动端', '模拟器', 'emulator', '设备',
]
const WEB_SIGNALS = [
  '浏览器', 'browser', 'electron', '网页', '页面', '前端', 'javascript', 'typescript', 'js 文件',
  'web', 'chrome', 'devtools', 'bundle', 'wasm', 'webview',
]

function hasSignal(text, signals) {
  const value = String(text || '').toLowerCase()
  return signals.some(signal => value.includes(signal))
}

function unique(list) {
  return [...new Set(list)]
}

/**
 * Decide which families a task needs.
 *
 * Precedence: an explicit manual selection wins, then a classifier result, then
 * keyword signals, then the core set. Unknown ids are dropped, so a bad answer
 * from the classifier can never advertise a family REA does not publish.
 */
export function planFamilies({ message = '', current = [], config = {}, classify, known = null } = {}) {
  const allowed = new Set(known ?? TOOL_FAMILY_IDS)
  const keep = list => unique(list.filter(id => allowed.has(id)))

  const manual = Array.isArray(config.toolFamilies) ? config.toolFamilies : []
  if (manual.length) return { families: keep(manual), source: 'manual', reason: '手动选择覆盖自动判断' }

  const base = keep(CORE_FAMILIES)
  if (classify) {
    let result
    try {
      result = classify(message)
    } catch (error) {
      result = null
    }
    if (Array.isArray(result) && result.length) {
      return { families: unique([...base, ...keep(result)]), source: 'classify', reason: '按任务分类补齐工具族' }
    }
  }

  const add = []
  if (hasSignal(message, MOBILE_SIGNALS)) add.push(...MOBILE_FAMILIES)
  if (hasSignal(message, WEB_SIGNALS)) add.push(...WEB_FAMILIES)
  if (add.length) {
    const groups = []
    if (add.some(id => MOBILE_FAMILIES.includes(id))) groups.push('移动端')
    if (add.some(id => WEB_FAMILIES.includes(id))) groups.push('Web')
    return { families: unique([...base, ...keep(add)]), source: 'signal', reason: `检测到${groups.join('与')}任务` }
  }

  if (current.length) {
    const kept = keep(current)
    // A previous task may have widened the scope; fall back to the core set so an
    // unrelated new task does not keep paying for families it will not use.
    if (kept.length && kept.every(id => base.includes(id))) return { families: kept, source: 'current', reason: '沿用当前核心族' }
  }
  return { families: base, source: 'default', reason: '默认核心族' }
}

/** Validate a classifier answer: an array of family ids or null. */
export function parseClassifierAnswer(value, known = []) {
  if (typeof value !== 'string') return null
  const allowed = new Set(known)
  const ids = value
    .split(/[\s,;]+/)
    .map(token => token.trim().toLowerCase().replace(/[^a-z-]/g, ''))
    .filter(token => token && allowed.has(token))
  return ids.length ? [...new Set(ids)] : null
}
