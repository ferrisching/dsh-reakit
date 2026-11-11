import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, rm, stat, unlink, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { runtimeRoot, NODE_VERSION } from './bootstrap.js'
import { REA_VERSION, REA_NODE_RANGE, inspectInstallation } from './config.js'
import { candidateForVersions, checkRuntimeUpdates, prepareRuntimeCandidate } from './runtime-versions.js'

const TRANSITION_FILE = '.runtime-transition.json'
const samePaths = (settings, point) => (settings.nodePath || '') === (point.nodePath || '') && (settings.reaEntry || '') === (point.reaEntry || '') && (settings.managedReaVersion || '') === (point.managedReaVersion || '') && (settings.managedNodeRange || '') === (point.managedNodeRange || '')
const paths = settings => ({ nodePath: settings.nodePath || '', reaEntry: settings.reaEntry || '', managedReaVersion: settings.managedReaVersion || '', managedNodeRange: settings.managedNodeRange || '' })
const point = (settings, runtime) => ({ ...paths({ ...settings, nodePath: runtime.nodePath || settings.nodePath, reaEntry: runtime.reaEntry || settings.reaEntry }), reaVersion: runtime.reaVersion || REA_VERSION, nodeVersion: runtime.nodeVersion || `v${NODE_VERSION}` })
const labels = value => ({ reaVersion: value.reaVersion, nodeVersion: value.nodeVersion })

function validPoint(value, allowEmpty) {
  if (!value || typeof value !== 'object') return false
  for (const key of ['nodePath', 'reaEntry']) {
    if (typeof value[key] !== 'string' || value[key].includes('\0') || (!allowEmpty && !isAbsolute(value[key])) || (value[key] && !isAbsolute(value[key]))) return false
  }
  if (Boolean(value.nodePath) !== Boolean(value.reaEntry) || Boolean(value.managedReaVersion) !== Boolean(value.managedNodeRange) || (!allowEmpty && (!value.managedReaVersion || !value.managedNodeRange))) return false
  return typeof value.reaVersion === 'string' && value.reaVersion.length < 64 && typeof value.nodeVersion === 'string' && value.nodeVersion.length < 64 && typeof (value.managedReaVersion || '') === 'string' && (value.managedReaVersion || '').length < 64 && typeof (value.managedNodeRange || '') === 'string' && (value.managedNodeRange || '').length < 256
}

/** Split parts under the managed root that a config points at. */
export async function managedParts(config, rootOverride) {
  // Records do not carry runtimeDir, so callers pass the manager's own root.
  const root = rootOverride ?? runtimeRoot(config)
  // A managed root behind a symlink (e.g. /var → /private/var) must still match.
  const canonical = await realpath(root).catch(() => root)
  const roots = [root, canonical].filter((value, index, all) => all.indexOf(value) === index)
  const parts = []
  for (const value of [config?.nodePath, config?.reaEntry]) {
    if (typeof value !== 'string' || !value) continue
    // Split layout: <root>/node/<id>/… and <root>/engine/<id>/…
    for (const kind of ['node', 'engine']) {
      for (const base of roots.map(item => join(item, kind) + sep)) {
        if (!value.startsWith(base)) continue
        const id = value.slice(base.length).split(sep)[0]
        const part = join(root, kind, id)
        if (id && !parts.includes(part)) parts.push(part)
      }
    }
    // Legacy combined generation: <root>/node-<...>/…
    for (const item of roots) {
      if (!value.startsWith(item + sep)) continue
      const legacy = value.slice(item.length + 1).split(sep)[0]
      if (legacy.startsWith('node-') && !parts.includes(join(root, legacy))) parts.push(join(root, legacy))
    }
  }
  return { root, parts }
}

/** Delete the previous version's parts that the new configuration does not use. */
async function discardReplaced(previous, current, root) {
  const before = await managedParts(previous, root)
  const after = new Set((await managedParts(current, root)).parts)
  const removed = []
  for (const part of before.parts) {
    if (after.has(part)) continue
    if (!part.startsWith(before.root + sep)) throw new Error('Refusing to delete outside the managed root')
    await rm(part, { recursive: true, force: true }).catch(() => {})
    removed.push(part)
  }
  return removed
}

/** Do the previous version's parts still exist on disk? */
async function partsPresent(config, root) {
  const { parts } = await managedParts(config, root)
  // No recorded managed paths means the earlier state was automatic: nothing to verify.
  if (!parts.length) return true
  for (const part of parts) { if (!await stat(part).catch(() => null)) return false }
  return true
}

export function createRuntimeVersionManager({ ctx, configuration, getRuntimeState, check = checkRuntimeUpdates, prepare = prepareRuntimeCandidate, inspect = inspectInstallation, candidateFrom = candidateForVersions }) {
  const candidates = new Map()
  let view = { phase: 'idle', candidate: null, transition: null, message: 'No update check yet; expanding and reading status stay offline' }
  let pending = false, transition, refreshPromise
  const readSettings = () => {
    const value = configuration.readStrict ? configuration.readStrict() : configuration.read()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cannot read the current plugin configuration strictly; refusing to switch runtimes')
    return value
  }
  const root = () => runtimeRoot(readSettings())
  const file = () => join(root(), TRANSITION_FILE)

  async function writeTransition(next) {
    if (dirname(file()) !== root()) throw new Error('Invalid runtime transition destination')
    const temporary = join(root(), `.runtime-transition-${next.id}.tmp`)
    if (dirname(temporary) !== root()) throw new Error('Runtime transition temporary path escapes its root')
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, file())
    transition = next
  }

  async function readTransition() {
    let value
    try {
      const info = await lstat(file())
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Runtime transition record must be a regular file')
      value = JSON.parse(await readFile(file(), 'utf8'))
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    if (value?.formatVersion !== 1 || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) || !['switching', 'ready', 'rolling-back'].includes(value.state) || !validPoint(value.from, true) || !validPoint(value.to, false) || dirname(file()) !== root()) throw new Error('Invalid runtime transition record; it was preserved')
    return value
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        transition = await readTransition()
        const settings = readSettings(), runtime = getRuntimeState()
        if (transition?.state === 'switching' && runtime.phase === 'ready' && samePaths(settings, transition.from)) {
          const current = await readTransition()
          if (current?.id === transition.id && current.state === 'switching') { await unlink(file()); transition = undefined }
        }
        if (transition?.state === 'switching' && runtime.phase === 'ready' && samePaths(settings, transition.to)) await writeTransition({ ...transition, state: 'ready' })
        if (transition?.state === 'rolling-back' && runtime.phase === 'ready' && samePaths(settings, transition.from)) {
          const current = await readTransition()
          if (current?.id === transition.id && current.state === 'rolling-back') { await unlink(file()); transition = undefined }
        }
        let projected = null
        if (transition) {
          projected = { state: transition.state, from: labels(transition.from), to: labels(transition.to), rollbackAvailable: ['ready', 'error'].includes(runtime.phase) }
        }
        view = { ...view, transition: projected }
      } catch (error) {
        view = { ...view, transition: null, message: `Failed to read the runtime transition record: ${error.message}` }
      }
    })().finally(() => { refreshPromise = undefined })
    return refreshPromise
  }
  void refresh()

  async function assertNoActiveAnalysis() {
    const settings = readSettings(), runtime = getRuntimeState()
    if (settings.enabled === false) return
    if (runtime.phase !== 'ready') throw new Error('Cannot confirm the analysis session state; restore the connection and export or close the session first')
    const name = `mcp__${settings.serverName || 'rea'}__binary_session`
    if (!ctx.get('tools')?.schemas().some(tool => tool.name === name)) throw new Error('Cannot check for an active analysis session; refusing to switch runtimes')
    const batch = await ctx.get('tools').execute({ calls: [{ id: `runtime-switch-${randomUUID()}`, name, arguments: JSON.stringify({}) }], signal: AbortSignal.timeout(30_000) })
    const result = batch.results[0]?.result, session = result?.value?.structuredContent?.result, activity = session?.analysis_activity
    const quiet = session?.open === false && session.cleanup_pending === false && session.analysis_run === null && activity && ['not_observed', 'idle'].includes(activity.status) && Array.isArray(activity.providers) && activity.providers.every(provider => provider.active === null && provider.queued_requests === 0)
    if (result?.isError || !quiet) throw new Error('Active, queued or uncleaned analysis work exists, or the session state is unknown; export and close it before switching')
  }

  function assertSwitchable() {
    const settings = readSettings()
    if (Boolean(settings.nodePath) !== Boolean(settings.reaEntry)) throw new Error('nodePath and reaEntry must be configured together; refusing to switch')
    if (!settings.nodePath) return
    const managed = transition && (samePaths(settings, transition.to) || (transition.state === 'rolling-back' && samePaths(settings, transition.from)))
    if (!managed) throw new Error('This is a manual runtime configuration; keep those paths or restore managed mode first. Version management never overwrites them')
  }

  async function operation(work) {
    if (pending) throw new Error('Another version operation is still running; wait for it to finish')
    pending = true
    view = { ...view, busy: true }
    try { return await work() }
    catch (error) {
      await refresh()
      view = { ...view, phase: view.phase === 'checking' ? 'error' : view.phase, message: error.message }
      throw error
    }
    finally { pending = false; view = { ...view, busy: false } }
  }

  async function checkUpdates(signal) {
    return operation(async () => {
      await refresh()
      const runtime = getRuntimeState(), settings = readSettings()
      view = { ...view, phase: 'checking', message: 'Reading official npm and Node.js release metadata' }
      const result = await check({ currentReaVersion: runtime.reaVersion || settings.managedReaVersion || REA_VERSION, currentNodeVersion: runtime.nodeVersion || `v${NODE_VERSION}`, currentReaNodeRange: runtime.nodeRange || settings.managedNodeRange || REA_NODE_RANGE, signal })
      const token = randomUUID()
      if (result.candidate) {
        if (candidates.size >= 4) candidates.delete(candidates.keys().next().value)
        candidates.set(token, { candidate: result.candidate, expires: Date.now() + 15 * 60_000 })
      }
      view = { ...view, ...result, phase: 'checked', token, message: result.candidate ? 'Official metadata checked only; nothing downloaded or switched yet' : result.reason }
      return view
    })
  }

  function confirmed(confirmation) {
    return confirmation?.confirmed === true && confirmation?.exported === true
  }

  async function prepareSwitch(token, confirmation, signal) {
    return operation(async () => {
      if (!confirmed(confirmation)) throw new Error('Confirm that the analysis session was exported or is not needed, and agree to switch versions')
      if (typeof token !== 'string' || !candidates.has(token) || candidates.get(token).expires < Date.now()) throw new Error('The update check expired; run the check again')
      const candidate = candidates.get(token).candidate
      assertSwitchable()
      await assertNoActiveAnalysis()
      const settings = readSettings(), runtime = getRuntimeState()
      const installation = await prepare(candidate, { ...settings, runtimeDir: root() }, { signal, inspect })
      await assertNoActiveAnalysis()
      const next = { formatVersion: 1, id: randomUUID(), state: 'switching', from: point(settings, runtime), to: { nodePath: installation.config.command, reaEntry: installation.config.args[0], managedReaVersion: installation.reaVersion, managedNodeRange: installation.nodeRange, reaVersion: installation.reaVersion, nodeVersion: installation.nodeVersion }, createdAt: new Date().toISOString() }
      if (samePaths(next.from, next.to)) throw new Error('That version is already in use; nothing to switch')
      await writeTransition(next)
      candidates.delete(token)
      view = { ...view, phase: 'switching', message: 'The new build passed preflight and is switching; the previous version is removed once the new one is in use' }
      // The previous version is the runtime that was actually in use before the
      // switch; automatic mode has no explicit paths in settings.
      const previous = { ...settings, nodePath: runtime.nodePath || settings.nodePath, reaEntry: runtime.reaEntry || settings.reaEntry }
      const installed = { ...next.to }
      await configuration.runtimePaths(paths(next.to), paths(settings))
      await refresh()
      // Only after the new runtime is actually in use: the previous version is
      // removed, so switching back re-installs it instead of keeping both.
      let discarded = []
      let discardError
      if (getRuntimeState().phase === 'ready') discarded = await discardReplaced(previous, installed, root()).catch((error) => { discardError = error.message; return [] })
      return { started: true, discarded, discardError, ...view }
    })
  }

  async function rollback(confirmation) {
    return operation(async () => {
      if (!confirmed(confirmation)) throw new Error('Rolling back also requires confirming the analysis session was exported or is not needed')
      await refresh()
      if (!transition) throw new Error('No runtime transition record to roll back')
      // refresh() may clear the record once the runtime is back on the old version.
      const record = transition
      const settings = readSettings(), runtime = getRuntimeState()
      if (!samePaths(settings, record.to) && !samePaths(settings, record.from)) throw new Error('The current configuration no longer belongs to that switch; refusing to overwrite later changes')
      if (runtime.phase === 'ready') await assertNoActiveAnalysis()
      else if (runtime.phase !== 'error' && settings.enabled !== false) throw new Error('The runtime is still preparing; rollback is not available yet')
      let restored = null
      const present = await partsPresent(record.from, root())
      if (!present) {
        // The upgrade deleted the previous version; rebuild it from the record.
        view = { ...view, phase: 'rolling-back', message: `Re-installing REA ${record.from.reaVersion} with Node ${record.from.nodeVersion}` }
        const candidate = await candidateFrom({ reaVersion: record.from.reaVersion, nodeVersion: record.from.nodeVersion, platform: process.platform, arch: process.arch })
        restored = await prepare(candidate, { ...settings, runtimeDir: root() }, { inspect })
      }
      await writeTransition({ ...record, state: 'rolling-back' })
      view = { ...view, phase: 'rolling-back', message: 'Restoring the previous runtime; the new version is removed afterwards' }
      const target = restored
        ? { nodePath: restored.config.command, reaEntry: restored.config.args[0], managedReaVersion: restored.reaVersion, managedNodeRange: restored.nodeRange }
        : record.from
      await configuration.runtimePaths(paths(target), paths(settings))
      await refresh()
      let discarded = []
      let discardError
      if (getRuntimeState().phase === 'ready') discarded = await discardReplaced(record.to, record.from, root()).catch((error) => { discardError = error.message; return [] })
      return { started: true, discarded, discardError, ...view }
    })
  }

  return {
    status() { void refresh(); return { ...view, transition: view.transition ? { ...view.transition } : null } },
    refresh, checkUpdates, prepareSwitch, rollback,
  }
}
