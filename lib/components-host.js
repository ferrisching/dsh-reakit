import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, realpath, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createComponentManager, JADX_RELEASE } from './components.js'
import { currentProfileContext, detectExistingRea, detectNodes, nodeOrigin, profilesUsingManagedRuntime, readNodeVersion, requiredNodeRange, verifyAdoption } from './existing-rea.js'
import { nodeArtifact, runProcess, runtimeLayout, runtimeRoot } from './bootstrap.js'
import { applySplitRuntime, planSplitRuntime } from './runtime-split.js'
import semver from 'semver'
import { createRuntimeVersionManager } from './runtime-manager.js'

const NAMESPACE = 'reaComponents'
const SERVICE = 'reaComponentsController'
// Unpacked size of a Node release, so the panel can state the cost up front.
const NODE_INSTALL_BYTES = { 'darwin-arm64': 210e6, 'darwin-x64': 220e6, 'linux-x64': 260e6, 'linux-arm64': 250e6, 'win32-x64': 200e6 }
const NODE_INSTALL_FALLBACK = 220e6

function artifactUrl() { return nodeArtifact().url }

/** Home-relative path for display, so the list stays readable. */
function displayPath(value) {
  const home = homedir()
  return typeof value === 'string' && value.startsWith(home + sep) ? '~' + value.slice(home.length) : value
}

const CALLS = { describe: [], status: [], retrySetup: [], setEnabled: ['enabled'], detectExisting: [], detectNodes: ['reaEntry'], nodeEnvironment: [], setNodeEnvironment: ['nodePath'], adoptExisting: ['reaEntry', 'nodePath'], installEngineWithHostNode: ['nodePath'], removeManagedNode: [], installManagedNode: [], useManagedRuntime: [], preferManaged: [], managedEnvironment: [], keepManagedEnvironment: [], removeManagedEnvironment: [], migrateRuntime: [], applyRuntimeSplit: [], checkRuntimeUpdates: [], prepareRuntimeSwitch: ['token', 'confirmation'], previewInstall: ['componentId'], install: ['token', 'confirm'], configure: ['componentId', 'values'] }

// Explicit source-JSON Typert descriptors are supported by 0.2.2-rc.1. Business
// inputs are validated below; all transport, Peer and owner policy stays official.
export const COMPONENTS_TYPERT = Object.freeze({
  package: 'dsh-reakit/components', face: 'host', schemas: [], model: { services: [], types: [], events: [], objects: [] },
  invocations: Object.entries(CALLS).map(([method, names]) => ({
    id: `dsh-reakit/components#${NAMESPACE}/${method}`,
    service: SERVICE, namespace: NAMESPACE, method,
    invocation: { kind: 'direct' },
    parameters: names.map(name => ({ name, wire: name, source: 'json', codec: { mode: 'src-json' } })),
    result: { mode: 'src-json' },
  })),
})

/** Download only the exact reviewed JAR; never execute it or an install script. */
export async function installReviewedJar(plan, signal, internals = {}) {
  const fetcher = internals.fetch ?? globalThis.fetch
  if (plan.source !== JADX_RELEASE.url || plan.sha256 !== JADX_RELEASE.sha256 || !plan.destination.endsWith('/jadx-headless-mcp-0.7.1-all.jar')) throw new Error('Download plan does not match the reviewed JADX release')
  const destination = resolve(plan.destination)
  const parent = dirname(destination)
  if (destination !== plan.destination || parent === destination) throw new Error('Invalid JAR destination directory')
  try {
    const existing = await stat(destination)
    if (!existing.isFile() || existing.size > 128 * 1024 * 1024 || createHash('sha256').update(await readFile(destination)).digest('hex') !== plan.sha256) throw new Error('Destination exists with different content; refusing to overwrite')
    return
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)])
  let url = plan.source
  let response
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new Error('Download redirect left the allowed HTTPS GitHub release hosts')
    response = await fetcher(url, { signal: deadline, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location')
      await response.body?.cancel()
      if (!next) throw new Error('Download redirect is missing its Location header')
      url = new URL(next, url).href
      response = undefined
    } else break
  }
  if (!response?.ok || !response.body) throw new Error(`JADX download failed: HTTP ${response?.status ?? 'too many redirects'}`)
  await mkdir(parent, { recursive: true, mode: 0o755 })
  const temporary = join(parent, `.jadx-${randomUUID()}.tmp`)
  // Both cleanup and publication operate on a fixed, checked child of parent.
  if (dirname(resolve(temporary)) !== parent) throw new Error('Temporary path escaped its directory')
  const file = await open(temporary, 'wx', 0o644)
  try {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of response.body) {
      deadline.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > 128 * 1024 * 1024) throw new Error('JADX download exceeds 128 MiB; refusing to write')
      hash.update(chunk)
      await file.writeFile(chunk)
    }
    if (hash.digest('hex') !== plan.sha256) throw new Error('JADX SHA-256 mismatch; nothing was installed')
    await file.sync()
    await file.close()
    // link is exclusive: unlike rename, a concurrent existing file is not lost.
    await link(temporary, destination)
  } finally {
    await file.close().catch(() => {})
    if (dirname(resolve(temporary)) === parent && /^\.jadx-[a-f0-9-]+\.tmp$/.test(temporary.slice(parent.length + 1))) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

function ownEntry(ctx, editor) {
  const matches = editor.entries().filter(entry => entry.fiber?.ctx.fiber === ctx.fiber || entry === ctx.fiber.entry)
  if (matches.length !== 1) throw new Error('Cannot uniquely locate the current dsh-reakit entry; refusing to touch another instance')
  return matches[0]
}

export function componentConfiguration(ctx) {
  function editor() {
    const value = ctx.get('configEditor')
    if (!value) throw new Error('The official ConfigEditor is unavailable; copy the AI setup prompt instead')
    return value
  }
  return {
    entryId() {
      try { return ownEntry(ctx, editor()).options.id ?? null } catch { return null }
    },
    read() {
      try {
        const service = editor()
        const entry = ownEntry(ctx, service)
        const layers = service.configuration().find(item => item.entry === entry)
        return { ...layers?.inherited, ...entry.options.config, env: { ...layers?.inherited?.env, ...entry.options.config?.env } }
      } catch { return {} }
    },
    readStrict() {
      const service = editor()
      const entry = ownEntry(ctx, service)
      const layers = service.configuration().find(item => item.entry === entry)
      return { ...layers?.inherited, ...entry.options.config, env: { ...layers?.inherited?.env, ...entry.options.config?.env } }
    },
    async env(patch) {
      const service = editor()
      await service.edit(ownEntry(ctx, service), (current, inherited) => ({ ...inherited, ...current, env: { ...inherited?.env, ...current.env, ...patch } }))
    },
    async enabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('The REA switch must be a boolean')
      const service = editor()
      await service.edit(ownEntry(ctx, service), (current, inherited) => ({ ...inherited, ...current, enabled }))
      return { saved: true, enabled, message: enabled ? 'Enable submitted; the host will reuse the runtime and re-register the REA tools' : 'Disable submitted; the host will release the REA MCP tools and keep the prepared runtime' }
    },
    async nodePathOnly(nodePath, expectedCurrent) {
      const service = editor()
      await service.edit(ownEntry(ctx, service), (current, inherited) => {
        if (expectedCurrent && (current?.nodePath || '') !== (expectedCurrent.nodePath || '')) throw new Error('Configuration changed in another window; nothing was overwritten. Check again before retrying')
        if (typeof nodePath !== 'string' || !nodePath) throw new Error('A Node path is required')
        return { ...inherited, ...current, nodePath }
      })
      return { saved: true }
    },
    async preferences(patch) {
      const service = editor()
      await service.edit(ownEntry(ctx, service), (current, inherited) => ({ ...inherited, ...current, ...patch }))
      return { saved: true }
    },
    async runtimePaths({ nodePath, reaEntry, managedReaVersion = '', managedNodeRange = '', keepManagedRuntime } = {}, expectedCurrent) {
      if (typeof nodePath !== 'string' || typeof reaEntry !== 'string' || (nodePath && !reaEntry) || (!nodePath && reaEntry) || Boolean(managedReaVersion) !== Boolean(managedNodeRange)) throw new Error('Runtime paths and version metadata must be supplied in pairs, or all cleared to restore managed mode')
      const service = editor()
      await service.edit(ownEntry(ctx, service), (current, inherited) => {
        if (expectedCurrent && ['nodePath', 'reaEntry', 'managedReaVersion', 'managedNodeRange'].some(key => (current?.[key] || '') !== (expectedCurrent[key] || ''))) throw new Error('Configuration changed in another window; nothing was overwritten. Check again before retrying')
        if (keepManagedRuntime === undefined) return { ...inherited, ...current, nodePath, reaEntry, managedReaVersion, managedNodeRange }
        return { ...inherited, ...current, nodePath, reaEntry, managedReaVersion, managedNodeRange, keepManagedRuntime }
      })
      return { saved: true }
    },
    writable() {
      try { ownEntry(ctx, editor()); return true } catch { return false }
    },
  }
}

async function directorySize(path) {
  let total = 0
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directorySize(child)
    else if (entry.isFile()) total += await stat(child).then(info => info.size).catch(() => 0)
  }
  return total
}

export class ComponentsController extends TypertRemoteService {
  constructor(ctx, options) {
    super(ctx, SERVICE, { namespace: NAMESPACE })
    this.manager = options.manager
    this.configuration = options.configuration
    this.retry = options.retrySetup
    this.installEngine = options.installEngineWithHostNode
    this.installManaged = options.installManagedRuntime
    this.runtime = options.getRuntimeState
    this.dependencies = options.getDependencyHints ?? (() => ({ missingDependency: false }))
    this.activity = options.getActivity ?? (() => ({ inflight: 0, tools: [] }))
    this.versions = options.versions
  }
  owner() {
    // Guard independently of RemoteAccess grants: this surface installs local
    // software and edits the owner's profile, never a shared-session delegate.
    if (this.ctx.invocation?.peer?.principal?.kind !== 'owner') throw new RemoteError('remote-access/denied', 'Component management is restricted to the authenticated host owner', { action: 'reaComponents', reason: 'owner-required' })
  }
  async describe() {
    this.owner()
    const view = await this.manager.describe()
    return { ...view, settingsEntryId: this.configuration.entryId?.() ?? null, configurationWritable: this.configuration.writable(), enabled: this.configuration.read().enabled !== false }
  }
  status() {
    this.owner()
    return { runtime: this.runtime(), settingsEntryId: this.configuration.entryId?.() ?? null, configurationWritable: this.configuration.writable(), enabled: this.configuration.read().enabled !== false, optionalTools: this.dependencies(), activity: this.activity(), runtimeVersions: this.versions?.status() ?? { phase: 'idle', candidate: null, transition: null } }
  }
  /** Install only the REA engine, reusing a Node that is already on this machine. */
  async installEngineWithHostNode(nodePath) {
    this.owner()
    if (typeof nodePath !== 'string' || !nodePath) throw new Error('A Node path is required')
    if (typeof this.installEngine !== 'function') throw new Error('Engine-only installation is not available in this build')
    const result = await this.installEngine(nodePath)
    return { ...result, ...await this.describe() }
  }
  async retrySetup() {
    this.owner()
    await this.retry()
    return this.describe()
  }
  setEnabled(enabled) {
    this.owner()
    if (typeof enabled !== 'boolean') throw new Error('The REA switch must be a boolean')
    // Dropping the bridge mid-call would orphan an in-flight REA tool call, so
    // disabling waits for the current call to settle. The owner UI shows this
    // reason; the check here is the authoritative backstop.
    const inflight = Number(this.activity()?.inflight) || 0
    if (!enabled && inflight > 0) throw new Error(`REA is running ${inflight} tool call(s); wait for them to finish before disabling, or the in-flight analysis will be interrupted`)
    return this.configuration.enabled(enabled)
  }
  async checkRuntimeUpdates() { this.owner(); await this.versions.checkUpdates(this.ctx.invocation.signal); return this.versions.status() }
  prepareRuntimeSwitch(token, confirmation) { this.owner(); return this.versions.prepareSwitch(token, confirmation, this.ctx.invocation.signal) }
  previewInstall(componentId) {
    this.owner()
    if (typeof componentId !== 'string') throw new Error('Invalid component id')
    return this.manager.previewInstall(componentId, this.ctx.invocation.signal)
  }
  install(token, confirm) {
    this.owner()
    if (typeof token !== 'string' || token.length > 100) throw new Error('Invalid install plan token')
    return this.manager.install(token, confirm, this.ctx.invocation.signal)
  }
  configure(componentId, values) { this.owner(); return this.manager.configure(componentId, values) }
  /** Read-only scan for a REA the user installed themselves. */
  async detectExisting() {
    this.owner()
    const runtime = this.runtime()
    const nodes = []
    if (runtime?.nodePath && runtime?.nodeVersion) nodes.push({ nodePath: runtime.nodePath, nodeVersion: runtime.nodeVersion })
    nodes.push({ nodePath: process.execPath, nodeVersion: process.version })
    const detected = await detectExistingRea({ nodes })
    const current = this.configuration.read()
    // A managed runtime also reports derived paths; only an explicit manual pair
    // (no managed version contract) means the user adopted their own install.
    const manual = Boolean(current.nodePath && current.reaEntry && !current.managedReaVersion)
    return { ...detected, current: { nodePath: current.nodePath || '', reaEntry: current.reaEntry || '', manual } }
  }
  /** Node binaries that could run the chosen REA, with compatibility. */
  async detectNodes(reaEntry) {
    this.owner()
    if (typeof reaEntry !== 'string' || !reaEntry) throw new Error('A reaEntry is required')
    const { range, reaVersion } = await requiredNodeRange(reaEntry)
    const runtime = this.runtime()
    const managed = runtime?.nodePath && runtime?.nodeVersion ? { nodePath: runtime.nodePath, nodeVersion: runtime.nodeVersion } : null
    const nodes = await detectNodes({ managed })
    const options = nodes.map(node => ({
      nodePath: node.nodePath,
      nodeVersion: node.nodeVersion,
      managed: Boolean(managed && node.nodePath === managed.nodePath),
      compatible: semver.satisfies(String(node.nodeVersion).replace(/^v/, ''), range),
      origin: nodeOrigin(node.nodePath, { managed: Boolean(managed && node.nodePath === managed.nodePath) }),
    }))
    options.sort((left, right) => Number(right.managed) - Number(left.managed) || Number(right.compatible) - Number(left.compatible) || semver.rcompare(left.nodeVersion, right.nodeVersion))
    return { reaEntry, reaVersion, range, nodes: options, managedCompatible: options.some(option => option.managed && option.compatible) }
  }
  /** Node binaries that could run the managed REA. */
  async nodeEnvironment() {
    this.owner()
    const settings = this.configuration.read()
    if (!settings.reaEntry) throw new Error('No managed REA is selected yet')
    const { range, reaVersion } = await requiredNodeRange(settings.reaEntry)
    const runtime = this.runtime()
    const canonical = async value => (value ? await realpath(value).catch(() => value) : '')
    const activeNode = await canonical(runtime?.nodePath)
    const root = runtimeRoot(settings)
    const layout = runtimeLayout(root, process.platform, process.arch)
    // Every Node the plugin has installed lives under runtime/node/<id>; list them
    // all, because a version switch can leave an older pinned tree behind.
    const managedRoot = join(root, 'node')
    const nodes = await detectNodes({})
    const installed = []
    for (const id of await readdir(managedRoot).catch(() => [])) {
      const dir = join(managedRoot, id)
      const marker = await readFile(join(dir, 'ready.json'), 'utf8').then(JSON.parse).catch(() => null)
      if (!marker) continue
      installed.push({ nodePath: join(dir, process.platform === 'win32' ? 'node.exe' : 'bin/node'), nodeVersion: `v${marker.nodeVersion}`, directory: dir })
    }
    const managedReal = new Set()
    for (const node of installed) {
      const real = await canonical(node.nodePath)
      managedReal.add(real)
      if (real === activeNode) nodes.unshift({ nodePath: node.nodePath, nodeVersion: node.nodeVersion })
    }
    // Nothing managed is running: offer the newest installed tree so the user can
    // switch back without seeing every historical generation as a separate Node.
    if (!nodes.some(node => node.nodePath.startsWith(managedRoot + sep))) {
      const newest = installed.sort((left, right) => semver.rcompare(left.nodeVersion, right.nodeVersion))[0]
      if (newest) nodes.unshift({ nodePath: newest.nodePath, nodeVersion: newest.nodeVersion })
    }
    const resolved = []
    for (const node of nodes) resolved.push({ node, real: await canonical(node.nodePath) })
    const managedNodePresent = installed.length > 0
    let managedNodeBytes = 0
    for (const tree of installed) managedNodeBytes += await directorySize(tree.directory).catch(() => 0)
    const managedNodeEstimate = NODE_INSTALL_BYTES[`${process.platform}-${process.arch}`] || NODE_INSTALL_FALLBACK
    const managedNodeDownload = await fetch(artifactUrl(), { method: 'HEAD', signal: AbortSignal.timeout(3_000) })
      .then(response => Number(response.headers.get('content-length')) || null)
      .catch(() => null)
    return {
      reaVersion, range, current: runtime?.nodePath || '',
      managedNodePath: layout.nodePath, managedNodePresent, managedNodeBytes, managedNodeEstimate, managedNodeDownload,
      nodes: resolved.map(({ node, real }) => ({
        nodePath: node.nodePath, nodeVersion: node.nodeVersion,
        displayPath: displayPath(node.nodePath),
        managed: managedReal.has(real),
        active: Boolean(activeNode && real === activeNode),
        compatible: semver.satisfies(String(node.nodeVersion).replace(/^v/, ''), range),
        origin: nodeOrigin(node.nodePath, { managed: managedReal.has(real) }),
      })),
    }
  }
  /** Switch only the Node that runs the managed REA. */
  async setNodeEnvironment(nodePath) {
    this.owner()
    if (typeof nodePath !== 'string' || !nodePath) throw new Error('A Node path is required')
    const settings = this.configuration.read()
    if (!settings.reaEntry) throw new Error('No managed REA is selected yet')
    const { range } = await requiredNodeRange(settings.reaEntry)
    const version = await readNodeVersion(nodePath)
    if (!version) throw new Error('That Node binary could not be read')
    if (!semver.satisfies(version.replace(/^v/, ''), range)) throw new Error(`Node ${version} does not satisfy ${range}`)
    return this.configuration.nodePathOnly(nodePath, { nodePath: settings.nodePath || '' })
  }
  /** Adopt an existing installation as the manual runtime pair. */
  async adoptExisting(reaEntry, nodePath) {
    this.owner()
    const current = this.configuration.read()
    const runtime = this.runtime()
    const chosen = typeof nodePath === 'string' && nodePath ? nodePath : (runtime?.nodePath || process.execPath)
    const nodeVersion = chosen === runtime?.nodePath ? runtime?.nodeVersion : process.version
    const candidate = await verifyAdoption({ nodePath: chosen, reaEntry, nodeVersion })
    await this.configuration.runtimePaths(
      { nodePath: chosen, reaEntry: candidate.entry, managedReaVersion: '', managedNodeRange: '', keepManagedRuntime: false },
      { nodePath: current.nodePath || '', reaEntry: current.reaEntry || '', managedReaVersion: current.managedReaVersion || '', managedNodeRange: current.managedNodeRange || '' },
    )
    return { saved: true, reaVersion: candidate.reaVersion, nodeVersion: candidate.nodeVersion }
  }
  /** Stop offering an existing install and provision the managed runtime instead. */
  async preferManaged() {
    this.owner()
    return this.configuration.preferences({ nodePreference: 'managed' })
  }
  /** Size of the downloaded runtime, so the UI can ask before deleting it. */
  async managedEnvironment() {
    this.owner()
    const root = runtimeRoot(this.configuration.read())
    const entries = await readdir(root).catch(() => [])
    const nodeBytes = await directorySize(join(root, 'node'))
    const engineBytes = await directorySize(join(root, 'engine'))
    const legacy = []
    for (const entry of entries) {
      // Combined generations from the old layout contain the REA install too.
      if (!entry.startsWith('node-')) continue
      legacy.push({ directory: entry, bytes: await directorySize(join(root, entry)) })
    }
    const { profilesRoot, currentProfile } = currentProfileContext()
    const blockedBy = profilesRoot ? await profilesUsingManagedRuntime({ profilesRoot, currentProfile }) : []
    return { root, nodeBytes, engineBytes, legacy, kept: this.configuration.read().keepManagedRuntime === true, blockedBy }
  }
  /** Keep the downloaded runtime: the user chose not to reclaim the space. */
  async keepManagedEnvironment() {
    this.owner()
    await this.configuration.preferences({ keepManagedRuntime: true })
    return { kept: true }
  }
  /**
   * Dry run only: report how legacy generations would map onto node/ + engine/.
   * It never creates, moves or deletes anything, and never touches configuration.
   */
  async migrateRuntime() {
    this.owner()
    const root = runtimeRoot(this.configuration.read())
    const plan = await planSplitRuntime({ root, platform: process.platform, arch: process.arch })
    return { dryRun: true, ...plan }
  }
  /**
   * Real migration: publish node/ + engine/ from the legacy generations.
   * Old generations and the current configuration are deliberately left intact.
   */
  async applyRuntimeSplit() {
    this.owner()
    const root = runtimeRoot(this.configuration.read())
    return applySplitRuntime({ root, platform: process.platform, arch: process.arch, run: runProcess })
  }
  /** Delete the downloaded runtime; switching back downloads it again. */
  async removeManagedEnvironment() {
    this.owner()
    const before = await this.managedEnvironment()
    if (before.blockedBy?.length) throw new Error(`The managed runtime is still used by profile(s): ${before.blockedBy.map(item => item.profile).join(', ')}; switch them to their own environment first`)
    const current = this.configuration.read()
    if (current.nodePath && !current.managedReaVersion) throw new Error('The managed runtime is in use by the adopted installation; switch back first')
    // Only the downloaded Node part is reclaimed; the installed REA engine stays
    // so switching back costs a Node download, not a full reinstall.
    await rm(join(before.root, 'node'), { recursive: true, force: true })
    return { removed: true, bytes: before.nodeBytes, legacyKept: before.legacy.length }
  }
  /** Download the plugin-managed Node again and run REA on it. */
  async installManagedNode() {
    this.owner()
    if (typeof this.installManaged !== 'function') throw new Error('Managed installation is not available in this build')
    const result = await this.installManaged()
    return { ...result, ...await this.describe() }
  }
  /** Reclaim the plugin-managed Node once another Node runs the engine. */
  async removeManagedNode() {
    this.owner()
    const settings = this.configuration.read()
    const runtime = this.runtime()
    const root = runtimeRoot(settings)
    const managedRoot = join(root, 'node')
    const canonical = async value => (value ? await realpath(value).catch(() => value) : '')
    const activeNode = await canonical(runtime?.nodePath)
    const configured = await canonical(settings.nodePath)
    const trees = []
    for (const id of await readdir(managedRoot).catch(() => [])) {
      const directory = join(managedRoot, id)
      const marker = await readFile(join(directory, 'ready.json'), 'utf8').then(JSON.parse).catch(() => null)
      if (!marker) continue
      const nodePath = join(directory, process.platform === 'win32' ? 'node.exe' : 'bin/node')
      trees.push({ directory, nodePath, real: await canonical(nodePath) })
    }
    const inUse = tree => (activeNode && tree.real === activeNode) || (configured && tree.real === configured)
    const victims = trees.filter(tree => !inUse(tree))
    if (!victims.length) throw new Error('The plugin-managed Node is in use; switch to another Node first')
    const blocked = await profilesUsingManagedRuntime(victims[0].directory).catch(() => [])
    if (blocked.length) throw new Error(`Still used by profile(s): ${blocked.map(item => item.profile).join(', ')}`)
    let bytes = 0
    for (const tree of victims) {
      bytes += await directorySize(tree.directory).catch(() => 0)
      await rm(tree.directory, { recursive: true, force: true })
    }
    return { removed: true, bytes }
  }
  /** Drop the manual pair so the managed runtime is used again. */
  async useManagedRuntime() {
    this.owner()
    const current = this.configuration.read()
    await this.configuration.runtimePaths(
      { nodePath: '', reaEntry: '', managedReaVersion: '', managedNodeRange: '', keepManagedRuntime: false },
      { nodePath: current.nodePath || '', reaEntry: current.reaEntry || '', managedReaVersion: current.managedReaVersion || '', managedNodeRange: current.managedNodeRange || '' },
    )
    return { saved: true }
  }
}

/** Optional UI registration never prevents the core MCP from initializing. */
export function registerComponents(ctx, { getRuntimeState, retrySetup, getDependencyHints, getActivity, installManagedRuntime, installEngineWithHostNode }) {
  const configuration = componentConfiguration(ctx)
  const manager = createComponentManager({ getRuntimeState, getSettings: () => configuration.read(), configure: patch => configuration.env(patch), installJar: installReviewedJar })
  const versions = ctx.get('configEditor') ? createRuntimeVersionManager({ ctx, configuration, getRuntimeState }) : undefined
  const fiber = ctx.inject(['typert'], child => {
    child.plugin(function componentController(inner) { new ComponentsController(inner, { manager, configuration, retrySetup, getRuntimeState, getDependencyHints, getActivity, versions, installManagedRuntime, installEngineWithHostNode }) })
    child.typert.register(COMPONENTS_TYPERT)
  })
  // Do not await an optional injection Fiber: without Typert this must not hold
  // up the full MCP catalog. A late registry still activates the child.
  return fiber
}
