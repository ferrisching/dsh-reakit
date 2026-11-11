import z from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { inspectInstallation, REA_NODE_RANGE, REA_VERSION } from './config.js'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRuntime, installEngineWithNode, npmCliFor, runtimeLayout, runtimeRoot } from './bootstrap.js'
import { detectNodeInstallers } from './node-install.js'
import { describeSetupFailure } from './setup-errors.js'
import { detectExistingRea, detectNodes, readNodeVersion, requiredNodeRange } from './existing-rea.js'
import semver from 'semver'
import { isDeepStrictEqual } from 'node:util'
import { createActivityTracker, createDependencyTracker } from './optional-tools.js'
import { inspectManagedRuntime } from './runtime-versions.js'

export const name = 'rea'
export const inject = ['tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  showComposerToggle: z.boolean().default(true).volatile(),
  autoSetup: z.boolean().default(true),
  // Empty keeps the official registry; set an https mirror for corporate networks.
  npmRegistry: z.string().default(''),
  // Empty keeps nodejs.org; set an https base for the Node distribution mirror.
  nodeMirror: z.string().default(''),
  // 'auto' offers an already-installed REA before downloading anything;
  // 'managed' skips that offer and provisions the pinned runtime.
  nodePreference: z.union([z.const('auto'), z.const('managed')]).default('auto'),
  // Set when the user chose to keep the downloaded runtime after adopting their own.
  keepManagedRuntime: z.boolean().default(false),
  runtimeDir: z.string().default(''),
  setupTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(600_000),
  nodePath: z.string().default(''),
  reaEntry: z.string().default(''),
  managedReaVersion: z.string().default(''),
  managedNodeRange: z.string().default(''),
  cwd: z.string().default(''),
  serverName: z.string().default('rea'),
  env: z.dict(String).default({}),
  inputSchemaProfile: z.union([z.const('compact'), z.const('full')]).default('compact'),
  outputSchemaProfile: z.union([z.const('full'), z.const('off')]).default('off'),
  toolCallTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(450_000),
})

async function registerDetails(ctx, hooks) {
  if (typeof ctx.get !== 'function') return
  const { registerComponents } = await import('./components-host.js')
  return registerComponents(ctx, hooks)
}

/** Dependencies are injectable so unit tests never download or install software. */
/** True when a managed runtime is already prepared for these settings. */
export async function hasManagedRuntime(settings) {
  try {
    const layout = runtimeLayout(runtimeRoot(settings), process.platform, process.arch)
    // Both trees must carry a readable marker; a half-removed runtime is not usable.
    const { readFile } = await import('node:fs/promises')
    const [node, engine] = await Promise.all([readFile(layout.nodeMarker, 'utf8'), readFile(layout.engineMarker, 'utf8')])
    return Boolean(JSON.parse(node)) && Boolean(JSON.parse(engine))
  } catch { return false }
}

export function createApply({ inspect = inspectInstallation, prepare = ensureRuntime, bridge = mcpClient, register = registerDetails, background = false } = {}) {
  return async function applyRea(ctx, config) {
    // Cordis already resolves volatile fields to references; direct test/CLI
    // callers may still pass raw booleans. Never validate the reference itself.
    const visibility = config?.showComposerToggle
    const settings = Config({ ...config, showComposerToggle: typeof visibility?.get === 'function' ? visibility.get() : visibility })
    if (Boolean(settings.managedReaVersion) !== Boolean(settings.managedNodeRange) || (settings.managedReaVersion && (!settings.nodePath || !settings.reaEntry))) throw new Error('managedReaVersion and managedNodeRange must accompany a complete dynamic runtime selection')
    const runtimeSettings = ({ showComposerToggle: _visibility, ...runtime }) => runtime
    const controller = new AbortController()
    let stopped = false, pending, bridgeFiber, bridgeCleanup
    const dependencyTracker = createDependencyTracker(settings.serverName)
    const activity = createActivityTracker(settings.serverName)
    let state = { phase: settings.enabled ? 'idle' : 'disabled', message: settings.enabled ? 'REA is waiting to initialize' : 'REA is disabled' }
    const disposeBridge = () => {
      if (!bridgeFiber) return bridgeCleanup ?? Promise.resolve()
      const owned = bridgeFiber
      bridgeFiber = undefined
      const cleanup = Promise.resolve(owned.dispose())
      bridgeCleanup = cleanup
      cleanup.finally(() => { if (bridgeCleanup === cleanup) bridgeCleanup = undefined }).catch(() => {})
      return cleanup
    }
    const stop = () => {
      stopped = true
      dependencyTracker.clear()
      activity.clear()
      controller.abort(new Error('REA plugin unloaded'))
      // The remote service holds this instance's state; drop it so the reloaded
      // plugin registers a fresh one instead of leaving a stale entry behind.
      void componentsFiber?.dispose?.().catch(error => ctx.logger?.warn?.(`REA component cleanup: ${error.message}`))
      // A child still awaiting initialize/tools.list must receive its own dispose event now.
      void disposeBridge().catch(error => ctx.logger?.warn?.(`REA bridge cleanup: ${error.message}`))
    }
    // Abort synchronously before Cordis starts awaiting effect cleanup.
    ctx.on?.('internal/plugin', (fiber) => { if (fiber === ctx.fiber && fiber.uid === null) stop() }, { global: true })
    // Config updates keep the same uid and may arrive while apply is still waiting.
    ctx.on?.('internal/update', (nextConfig, next) => {
      // Presentation-only edits must not kill the REA process or its in-memory
      // evidence. Cordis publishes the accepted effectiveConfig on this veto.
      if (isDeepStrictEqual(runtimeSettings(settings), runtimeSettings(nextConfig))) return
      stop()
      return next()
    })
    ctx.effect?.(() => () => { stop(); return bridgeCleanup }, 'rea.initialization.abort')
    const currentState = () => {
      const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
      if (state.phase === 'ready' && typeof tools?.schemas === 'function' && !tools.schemas().some(tool => tool.name === `mcp__${settings.serverName}__binary_session`)) {
        state = { ...state, phase: 'error', message: 'REA has no registered tools (disconnected or reconnecting); retry the connection from settings' }
      }
      return { ...state }
    }
    // Final-result observation is read-only and fiber-owned. Never probe tools
    // or replay calls here; an unrelated failure must not become an install hint.
    if (settings.enabled) ctx.on?.('tools/result', (exec, result) => {
      if (stopped || state.phase !== 'ready') return
      try {
        const tools = ctx.get?.('tools')
        if (typeof tools?.get === 'function') {
          const base = tools.get(exec.name)
          if (!base || tools.get(exec.name, exec.agent, exec.toolSet) !== base) return
        }
        dependencyTracker.observe(exec, result)
      } catch { /* A hint must never change or obstruct tool execution. */ }
    })
    // Official around-dispatch waterfall: observe REA calls in flight without
    // altering the result or the caller signal. Bookkeeping never throws, and the
    // paired finally means a rejected body cannot leave a stuck indicator.
    if (settings.enabled && typeof ctx.on === 'function') ctx.on('tools/execute', async (exec, next) => {
      let tracked = false
      try { tracked = !stopped && activity.begin(exec) } catch { tracked = false }
      try {
        return await next()
      } finally {
        if (tracked) { try { activity.end(exec) } catch { /* indicator only */ } }
      }
    })
    const initialize = () => {
      if (!settings.enabled) return Promise.resolve(state)
      if (currentState().phase === 'ready') return Promise.resolve(state)
      if (pending) return pending
      pending = (async () => {
        if (stopped) throw new Error('REA plugin is no longer active')
        state = { phase: 'preparing', message: 'Preparing the managed Node and REA runtime' }
        try {
          await disposeBridge()
          const hasNode = Boolean(settings.nodePath), hasEntry = Boolean(settings.reaEntry)
          if (hasNode !== hasEntry) throw new Error('Set both nodePath and reaEntry, or leave both empty for automatic setup')
          // Prefer what the user already has before downloading hundreds of MB.
          if (!hasNode && settings.autoSetup && settings.nodePreference === 'auto') {
            const own = await detectExistingRea({ nodes: [{ nodePath: process.execPath, nodeVersion: process.version }] }).catch(() => null)
            const usable = (own?.candidates || []).filter(candidate => candidate.usable)
            if (usable.length) {
              state = { phase: 'choose', message: 'A usable REA installation was found; choose it or provision the managed runtime', choice: usable.map(candidate => ({ reaVersion: candidate.reaVersion, reaEntry: candidate.entry, nodePath: candidate.nodePath, nodeVersion: candidate.nodeVersion })) }
              return state
            }
            // Nothing usable on this machine: ask where Node should live instead of
            // downloading into the plugin directory without consent.
            const installed = await hasManagedRuntime(settings)
            if (!installed) {
              // A machine Node that already satisfies REA can carry the engine alone,
              // which avoids downloading the plugin-managed Node again.
              const hostNodes = []
              for (const candidate of await detectNodes({}).catch(() => [])) {
                const version = String(candidate.nodeVersion).replace(/^v/, '')
                if (!semver.satisfies(version, REA_NODE_RANGE)) continue
                if (!await stat(npmCliFor(candidate.nodePath)).catch(() => null)) continue
                hostNodes.push({ nodePath: candidate.nodePath, nodeVersion: candidate.nodeVersion })
              }
              state = {
                phase: 'choose-install',
                message: 'No usable Node or REA was found; choose where to install them',
                installers: await detectNodeInstallers(),
                hostNodes,
              }
              return state
            }
          }
          // managedReaVersion records which engine is installed, but nodePath may point
          // at a Node outside the managed root; that pair is validated by inspect().
          const managedPair = hasNode && settings.managedReaVersion ? await inspectManagedRuntime(settings, inspect) : null
          const installation = hasNode ? (managedPair ?? await inspect(settings)) : await prepare(settings, {
            signal: controller.signal,
            log: (message) => { state = { ...state, message }; ctx.logger?.info?.(message) },
          })
          controller.signal.throwIfAborted()
          state = { phase: 'preparing', message: 'Connecting the complete REA MCP tool catalog',
            nodeVersion: installation.nodeVersion, reaVersion: installation.reaVersion, nodeRange: installation.nodeRange,
            nodePath: installation.config.command, reaEntry: installation.config.args[0] }
          // Own each bridge attempt in a child fiber so a failed handshake can be retried safely.
          if (typeof ctx.plugin === 'function') {
            bridgeFiber = ctx.plugin(bridge, bridge.Config(installation.config))
            await bridgeFiber
          } else await bridge.apply(ctx, bridge.Config(installation.config))
          controller.signal.throwIfAborted()
          state = { ...state, phase: 'ready', message: 'REA is connected; optional providers retain their own requirements' }
          return state
        } catch (error) {
          await disposeBridge()
          // Surface whether this was the network, the disk or permissions.
          state = { ...state, phase: 'error', message: describeSetupFailure(error, { root: runtimeRoot(settings) }) }
          throw error
        } finally { pending = undefined }
      })()
      return pending
    }
    async function installManagedRuntime() {
      const layout = runtimeLayout(runtimeRoot(settings), process.platform, process.arch)
      state = { ...state, phase: 'preparing', message: 'Downloading the plugin-managed Node' }
      const installation = await prepare(settings, {
        signal: controller.signal,
        log: (message) => { state = { ...state, message }; ctx.logger?.info?.(message) },
      })
      const editor = ctx.get('configEditor')
      const entry = editor.entries().find(item => item.options.name === 'dsh-reakit')
      if (!entry) throw new Error('Cannot find this plugin configuration entry')
      const next = { nodePath: installation.config.command, reaEntry: installation.config.args[0], managedReaVersion: REA_VERSION, managedNodeRange: REA_NODE_RANGE }
      await editor.edit(entry, (current, inherited) => ({ ...inherited, ...current, ...next }))
      // The configuration change restarts this plugin; the fresh apply connects.
      return { nodePath: installation.config.command, ...next }
    }
    async function installEngineWithHostNode(nodePath) {
      const version = await readNodeVersion(nodePath)
      if (!version || !semver.satisfies(version.replace(/^v/, ''), REA_NODE_RANGE)) throw new Error('That Node does not satisfy the REA Node range')
      const layout = runtimeLayout(runtimeRoot(settings), process.platform, process.arch)
      state = { ...state, phase: 'preparing', message: 'Installing the REA engine with the Node already on this machine' }
      const engine = await installEngineWithNode({ root: runtimeRoot(settings), engineDirectory: layout.engineDirectory, nodePath, log: message => { state = { ...state, message }; ctx.logger?.info?.(message) } })
      const editor = ctx.get('configEditor')
      const entry = editor.entries().find(item => item.options.name === 'dsh-reakit')
      if (!entry) throw new Error('Cannot find this plugin configuration entry')
      const next = { nodePath, reaEntry: layout.reaEntry, managedReaVersion: REA_VERSION, managedNodeRange: REA_NODE_RANGE }
      await editor.edit(entry, (current, inherited) => ({ ...inherited, ...current, ...next }))
      // The configuration change restarts this plugin; the fresh apply connects.
      return { engine: engine.engineDirectory, nodePath }
    }
    let componentsFiber
    try { componentsFiber = await register(ctx, { getRuntimeState: currentState, retrySetup: initialize, getDependencyHints: dependencyTracker.snapshot, getActivity: activity.snapshot, installEngineWithHostNode, installManagedRuntime }) }
    catch (error) { ctx.logger?.warn?.(`REA component details unavailable: ${error.message}`) }
    if (!settings.enabled) return
    const start = initialize()
    if (background && !settings.nodePath && !settings.reaEntry) {
      // ConfigEditor requires an active owner: keep settings/cancel available during a cold download.
      const settled = start.catch(error => {
        if (!stopped) ctx.logger?.error?.(`REA initialization failed; retry from plugin details: ${error.message}`)
      })
      ctx.effect?.(() => () => settled, 'rea.initialization.settlement')
      return
    }
    try { await start }
    catch (error) {
      if (settings.nodePath || settings.reaEntry || stopped) throw error
      ctx.logger?.error?.(`REA initialization failed; retry from plugin details: ${error.message}`)
    }
  }
}

export const apply = createApply({ background: true })
