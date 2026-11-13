import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutoToolRouter, classifyWithLlm, latestUserText } from '../lib/auto-routing.js'
import { CORE_FAMILIES, MOBILE_FAMILIES } from '../lib/tool-routing.js'

function fixture({ mode = 'auto', families = [], inflight = 0, llm } = {}) {
  const settings = { toolRouting: mode, toolFamilies: families, toolFamiliesAuto: [] }
  const writes = []
  const configuration = {
    read: () => settings,
    toolFamilies: async list => { writes.push(list); settings.toolFamilies = list; settings.toolFamiliesAuto = [] },
    autoToolFamilies: async list => { writes.push(list); settings.toolFamilies = list; settings.toolFamiliesAuto = list },
  }
  const listeners = {}
  const ctx = { on: (name, fn) => { listeners[name] = fn; return () => { delete listeners[name] } } }
  const activity = { inflight }
  const router = createAutoToolRouter({ ctx, configuration, llm, getActivity: () => activity, timeoutMs: 20 })
  const next = () => 'next'
  return { router, listeners, writes, settings, activity, next }
}

function modelLlm(answer) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'cheap' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    stream: options => {
      calls.push(options)
      return (async function* () { yield { type: 'text', text: answer } })()
    },
  }
}

test('the newest user message is the task, not a tool result', () => {
  assert.equal(latestUserText([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]), 'second')
  assert.equal(latestUserText([{ role: 'assistant', content: 'only assistant' }]), '')
  assert.equal(latestUserText([]), '')
  assert.equal(latestUserText(null), '')
})

test('manual mode never classifies and never rewrites the scope', async () => {
  const llm = modelLlm('android')
  const f = fixture({ mode: 'manual', llm })
  const result = await f.router.onPreStep({ messages: [{ role: 'user', content: '分析 APK' }] }, f.next)
  assert.equal(result, 'next')
  assert.equal(llm.calls.length, 0)
  assert.equal(f.writes.length, 0)
})

test('a classifier answer is applied once, with the core families kept', async () => {
  const llm = modelLlm('android, frida')
  const f = fixture({ llm })
  await f.router.onPreStep({ messages: [{ role: 'user', content: '分析 APK' }] }, f.next)
  assert.equal(llm.calls.length, 1)
  assert.equal(f.writes.length, 1)
  for (const id of [...CORE_FAMILIES, 'android', 'frida']) assert.equal(f.writes[0].includes(id), true)
  // the fixed cheap model is used, not the chat model
  assert.equal(llm.calls[0].model, 'deepseek-flash')
  assert.equal(llm.calls[0].provider, 'cheap')
  assert.equal(llm.calls[0].purpose, 'tool-routing')
})

test('the cache is keyed by message content, not by step count', async () => {
  const llm = modelLlm('android')
  const f = fixture({ llm })
  const message = [{ role: 'user', content: '分析 APK' }]
  await f.router.onPreStep({ messages: message }, f.next)
  await f.router.onPreStep({ messages: message }, f.next)
  assert.equal(llm.calls.length, 1, 'same message is answered from cache')

  await f.router.onPreStep({ messages: [{ role: 'user', content: '抓一下 chrome 的网络请求' }] }, f.next)
  assert.equal(llm.calls.length, 2, 'a different message is a new task')
})

test('a failing classifier falls back to the keyword rules without throwing', async () => {
  const llm = {
    listProviders: () => [{ id: 'cheap' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    stream: () => { throw new Error('provider down') },
  }
  const f = fixture({ llm })
  const result = await f.router.onPreStep({ messages: [{ role: 'user', content: '分析 APK' }] }, f.next)
  assert.equal(result, 'next')
  assert.equal(f.writes.length, 1)
  for (const id of MOBILE_FAMILIES) assert.equal(f.writes[0].includes(id), true)
})

test('a classifier that hangs is timed out and falls back to keywords', async () => {
  const llm = {
    listProviders: () => [{ id: 'cheap' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    // honour the abort signal, the way a real adapter does
    stream: options => ({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })) }
      },
    }),
  }
  const f = fixture({ llm })
  const started = Date.now()
  const result = await f.router.onPreStep({ messages: [{ role: 'user', content: '分析 APK' }] }, f.next)
  assert.equal(result, 'next')
  assert.ok(Date.now() - started < 5000, 'timeout must not stall the step')
  for (const id of MOBILE_FAMILIES) assert.equal(f.writes[0].includes(id), true)
})

test('a manual selection always wins, even in auto mode', async () => {
  const llm = modelLlm('android')
  const f = fixture({ llm, families: ['native'] })
  await f.router.onPreStep({ messages: [{ role: 'user', content: '分析 APK' }] }, f.next)
  assert.equal(llm.calls.length, 0, 'a manual override needs no classification')
  assert.equal(f.writes.length, 0, 'the manual list is already in place, nothing to rewrite')
})

test('a plan applies without waiting for an in-flight tool call', async () => {
  const llm = modelLlm('android')
  const f = fixture({ llm, inflight: 1 })
  await f.router.onPreStep({ messages: [{ role: 'user', content: '分析 APK' }] }, f.next)
  assert.equal(f.writes.length, 1, 'volatile scope writes never interrupt the running call')

  f.activity.inflight = 0
  await f.router.onPreStep({ messages: [{ role: 'user', content: '分析 APK' }] }, f.next)
  assert.equal(f.writes.length, 1, 'the same plan is not persisted twice')
  assert.equal(llm.calls.length, 1, 'no second classification for the same message')
})

test('an empty or absent message never triggers the classifier', async () => {
  const llm = modelLlm('android')
  const f = fixture({ llm })
  await f.router.onPreStep({ messages: [] }, f.next)
  await f.router.onPreStep({}, f.next)
  assert.equal(llm.calls.length, 0)
})

test('classifyWithLlm parses only known families and tolerates junk', async () => {
  const llm = modelLlm('android, not-a-family\n`frida`')
  assert.deepEqual(await classifyWithLlm(llm, 'task', { timeoutMs: 100 }), ['android', 'frida'])
  assert.equal(await classifyWithLlm(modelLlm(''), 'task', { timeoutMs: 100 }), null)
})

test('a broken provider is skipped and the working one is remembered', async () => {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'broken' }, { id: 'good' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    stream: options => {
      calls.push(options.provider)
      if (options.provider === 'broken') {
        return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'TRANSPORT' } } } })()
      }
      return (async function* () { yield { type: 'text', text: 'android' } })()
    },
  }
  assert.deepEqual(await classifyWithLlm(llm, '分析 APK', { timeoutMs: 100 }), ['android'])
  assert.deepEqual(calls, ['broken', 'good'])
  calls.length = 0
  assert.deepEqual(await classifyWithLlm(llm, '另一个任务', { timeoutMs: 100 }), ['android'])
  assert.deepEqual(calls, ['good'], 'the next task starts with the provider that worked')
})

test('the classifier request uses content blocks, not a string body', async () => {
  const llm = modelLlm('android')
  await classifyWithLlm(llm, '分析 APK', { timeoutMs: 100 })
  assert.deepEqual(llm.calls[0].messages, [{ role: 'user', content: [{ type: 'text', text: '分析 APK' }] }])
})

test('reasoning deltas are never parsed as the answer', async () => {
  const llm = {
    listProviders: () => [{ id: 'cheap' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    stream: () => (async function* () {
      yield { type: 'reasoning-delta', text: 'android adb apktool ' }
      yield { type: 'text-delta', text: 'frida' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  assert.deepEqual(await classifyWithLlm(llm, 'hook 一下', { timeoutMs: 100 }), ['frida'])
})

test('a "none" answer succeeds without trying another provider', async () => {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'first' }, { id: 'second' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    stream: options => {
      calls.push(options.provider)
      return (async function* () { yield { type: 'text-delta', text: 'none' } })()
    },
  }
  assert.equal(await classifyWithLlm(llm, '看看这个 Mach-O', { timeoutMs: 100 }), null)
  assert.deepEqual(calls, ['first'])
})

test('an empty answer body still fails over to the next provider', async () => {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'empty' }, { id: 'good' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    stream: options => {
      calls.push(options.provider)
      return options.provider === 'empty'
        ? (async function* () {})()
        : (async function* () { yield { type: 'text-delta', text: 'android' } })()
    },
  }
  assert.deepEqual(await classifyWithLlm(llm, '分析 APK', { timeoutMs: 100 }), ['android'])
  assert.deepEqual(calls, ['empty', 'good'])
})

test('an auto-applied scope does not lock later tasks into manual mode', async () => {
  const answers = ['android', 'browser']
  const llm = {
    listProviders: () => [{ id: 'cheap' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    stream: () => (async function* () { yield { type: 'text-delta', text: answers.shift() } })(),
  }
  const f = fixture({ llm })
  await f.router.onPreStep({ messages: [{ role: 'user', content: '分析 APK' }] }, f.next)
  await f.router.onPreStep({ messages: [{ role: 'user', content: '分析这个网页的 bundle' }] }, f.next)
  assert.equal(f.writes.length, 2, 'the second task must be routed too')
  assert.equal(f.writes[0].includes('android'), true)
  assert.equal(f.writes[1].includes('browser'), true)
  assert.equal(f.writes[1].includes('android'), false, 'the previous task scope is replaced')
})
