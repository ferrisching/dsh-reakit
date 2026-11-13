// Automatic, task-based tool routing.
//
// The pure decision table lives in tool-routing.js. This module only feeds it:
// it reads the newest user message at `agent/pre-step`, asks a cheap model to
// classify the task, and persists the resulting tool families.
//
// Two hard rules:
//  - the cache key is the message text itself, so a new task invalidates it;
//  - nothing here ever throws. A slow, failing or absent classifier falls back
//    to the keyword rules, and a failing step is never caused by routing.

import { TOOL_FAMILY_IDS } from './config.js'
import { planFamilies, parseClassifierAnswer, ROUTING_MODEL } from './tool-routing.js'

const CLASSIFIER_SYSTEM = [
  'You classify reverse-engineering tasks into tool families.',
  'Reply with a comma-separated list of family ids only, no explanation.',
  `Allowed ids: ${TOOL_FAMILY_IDS.join(', ')}.`,
  'These core families are already enabled: direct, enhanced, native, artifact, managed, firmware, pcap, session, application.',
  'Answer only ADDITIONAL families the task needs beyond that core set, at most 4 ids.',
  'Answer "none" when the core set is enough; static native analysis usually needs none.',
  'Use frida only when dynamic instrumentation or hooking is explicitly requested.',
  'Use android, adb, apktool or jeb only for Android work, and flutter only for Flutter.',
  'Use browser, electron or javascript-runtime only for web, browser, Electron or JavaScript analysis.',
].join('\n')

/** The newest user message, as plain text. Tool results are not tasks. */
export function latestUserText(messages, maxChars = 4000) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const content = message.content ?? message.text
    if (typeof content === 'string') return content.trim().slice(0, maxChars)
    if (Array.isArray(content)) {
      const text = content
        .filter(part => part && (part.type === undefined || part.type === 'text'))
        .map(part => typeof part === 'string' ? part : part.text || '')
        .join('\n')
        .trim()
      return text.slice(0, maxChars)
    }
    return ''
  }
  return ''
}

/** Every provider route that claims to serve the fixed routing model. */
async function routingProviders(llm) {
  if (typeof llm?.listProviders !== 'function' || typeof llm?.listModels !== 'function') return []
  const providers = []
  for (const provider of llm.listProviders()) {
    const id = typeof provider === 'string' ? provider : provider?.id
    if (!id) continue
    const models = await llm.listModels(id).catch(() => [])
    if (models.some(model => (model?.id ?? model) === ROUTING_MODEL.model)) providers.push(id)
  }
  return providers
}

// A provider can list the model and still fail at call time (missing key,
// transport error). Remember the route that last answered so later tasks do not
// pay for the broken one again.
const lastGoodProvider = new WeakMap()

/** One classification attempt against one provider; null means "try the next". */
async function classifyWithProvider(llm, provider, text, { timeoutMs, signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('tool-routing classifier timed out')), timeoutMs)
  const onAbort = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const options = {
      provider,
      model: ROUTING_MODEL.model,
      purpose: ROUTING_MODEL.purpose,
      system: CLASSIFIER_SYSTEM,
      // RequestMessage.content is a ContentBlock array, not a string.
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      temperature: 0,
      maxTokens: 120,
      signal: controller.signal,
    }
    let answer = ''
    let failed = false
    for await (const chunk of llm.stream(options)) {
      // reasoning-delta also carries `text`; it is the model thinking aloud, not
      // the answer, and must never reach the family parser.
      if (chunk?.type === 'reasoning-delta') continue
      if (typeof chunk === 'string') answer += chunk
      else if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text
      else if (chunk?.type === 'text' && typeof chunk.text === 'string') answer += chunk.text
      else if (!chunk?.type && typeof chunk?.text === 'string') answer += chunk.text
      else if (!chunk?.type && typeof chunk?.content === 'string') answer += chunk.content
      else if (typeof chunk?.delta?.text === 'string' && chunk?.type !== 'reasoning-delta') answer += chunk.delta.text
      // A transport failure arrives as a finish chunk, not as a thrown error.
      if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') failed = true
    }
    if (failed) return { ok: false }
    // "none" is a valid answer and must stop the failover; an empty body is not.
    if (!answer.trim()) return { ok: false }
    return { ok: true, ids: parseClassifierAnswer(answer, TOOL_FAMILY_IDS) }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** Classify one task. Any failure, including a timeout, answers null. */
export async function classifyWithLlm(llm, text, { timeoutMs = 8000, signal } = {}) {
  if (typeof llm?.stream !== 'function') return null
  const providers = await routingProviders(llm).catch(() => [])
  const preferred = lastGoodProvider.get(llm)
  const ordered = preferred ? [preferred, ...providers.filter(id => id !== preferred)] : providers
  for (const provider of ordered) {
    const result = await classifyWithProvider(llm, provider, text, { timeoutMs, signal })
    if (result.ok) {
      lastGoodProvider.set(llm, provider)
      return result.ids
    }
  }
  return null
}

function sameFamilies(left, right) {
  const a = [...(left || [])].sort(), b = [...(right || [])].sort()
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * Wire the router into the agent loop.
 *
 * `configuration` is the component configuration surface: read() plus
 * toolFamilies(list). `llm` is injectable so tests never call a model.
 * The returned dispose function removes the listener.
 */
export function createAutoToolRouter({ ctx, configuration, llm, getActivity, timeoutMs = 8000, routing } = {}) {
  const cache = { key: null, plan: null, applied: [] }
  const resolveLlm = () => llm ?? (typeof ctx.get === 'function' ? ctx.get('llm') : undefined)

  async function onPreStep(payload, next) {
    try {
      const settings = configuration.read()
      if (settings.toolRouting !== 'auto') return next()
      const text = latestUserText(payload?.messages)
      if (!text) return next()

      // An auto-applied scope is not a manual choice. Without this distinction the
      // first automatic write would lock every later task into the same families.
      // Editing the list by hand clears toolFamiliesAuto and wins over routing.
      const autoApplied = Array.isArray(settings.toolFamiliesAuto) ? settings.toolFamiliesAuto : cache.applied
      const manualOverride = Array.isArray(settings.toolFamilies) && settings.toolFamilies.length > 0 && !sameFamilies(settings.toolFamilies, autoApplied)
      if (manualOverride) return next()

      // A different message is a different task: recompute. The same message is
      // served from cache and never calls the classifier twice.
      if (cache.key !== text) {
        cache.key = text
        let ids = null
        if (resolveLlm()) ids = await classifyWithLlm(resolveLlm(), text, { timeoutMs, signal: payload?.signal })
        cache.plan = planFamilies({ message: text, current: settings.toolFamilies, config: { ...settings, toolFamilies: [] }, classify: () => ids })
      }

      const plan = cache.plan
      if (!plan) return next()
      // The live scope is in memory: the next model step sees it immediately.
      if (routing) routing.plan = plan

      // Persist only so the settings panel can display the automatic scope. This
      // field is volatile, so the write does not restart REA or interrupt a call.
      const current = configuration.read()
      if (sameFamilies(plan.families, current.toolFamilies) && sameFamilies(plan.families, current.toolFamiliesAuto)) return next()
      if (typeof configuration.autoToolFamilies === 'function') await configuration.autoToolFamilies(plan.families)
      else await configuration.toolFamilies(plan.families)
      cache.applied = plan.families
    } catch {
      // Routing must never fail a model step.
    }
    return next()
  }

  const dispose = typeof ctx.on === 'function' ? ctx.on('agent/pre-step', onPreStep) : () => {}
  return { dispose, onPreStep, cache }
}
