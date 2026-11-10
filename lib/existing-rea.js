// Detecting a REA the user already installed globally.
//
// This never launches REA and never touches the network: it only reads package
// metadata for candidate roots it can name deterministically. Anything it
// cannot verify is reported as a reason instead of a silent "ready".
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { homedir } from 'node:os'
import semver from 'semver'

export const REA_PACKAGE = 'rea-agents'
const MAX_ROOTS = 16
const MAX_CANDIDATES = 6

const execFile = promisify(execFileCallback)
const isFile = async path => { try { return (await stat(path)).isFile() } catch { return false } }
const isDir = async path => { try { return (await stat(path)).isDirectory() } catch { return false } }

/** Global node_modules roots that can hold `rea-agents`, without running npm. */
export async function candidateRoots({ env = {}, nodePath = process.execPath, home = homedir() } = {}) {
  const roots = new Set()
  const add = value => { if (typeof value === 'string' && value.endsWith(`node_modules`) && roots.size < MAX_ROOTS) roots.add(value) }
  // …/bin/node → …/lib/node_modules (the layout of every official Node build).
  if (nodePath) add(join(dirname(dirname(nodePath)), 'lib', 'node_modules'))
  for (const entry of String(env.NODE_PATH ?? '').split(sep === '/' ? ':' : ';')) add(entry)
  for (const prefix of ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules', join(home, '.npm-global', 'lib', 'node_modules'), join(home, 'Library', 'pnpm', 'global', '5', 'node_modules'), join(home, '.config', 'yarn', 'global', 'node_modules')]) add(prefix)
  // Windows keeps global packages under APPDATA, and pnpm under LOCALAPPDATA.
  if (env.APPDATA) add(join(env.APPDATA, 'npm', 'node_modules'))
  if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'pnpm', 'global', '5', 'node_modules'))
  if (env.ProgramFiles) add(join(env.ProgramFiles, 'nodejs', 'node_modules'))
  // nvm keeps one tree per installed Node; read only one directory level.
  const nvm = join(home, '.nvm', 'versions', 'node')
  if (await isDir(nvm)) {
    for (const version of (await readdir(nvm).catch(() => [])).slice(-4)) add(join(nvm, version, 'lib', 'node_modules'))
  }
  return [...roots]
}

/**
 * Validate one candidate directory as a REA installation.
 * Returns a candidate record; `usable` is false with a reason when it cannot run.
 */
export async function inspectExistingRea({ root, nodePath, nodeVersion }) {
  // nodePath/nodeVersion are the Node the adopted REA would actually run under.
  const directory = join(root, REA_PACKAGE)
  const metadataPath = join(directory, 'package.json')
  let metadata
  try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')) } catch { return null }
  if (metadata?.name !== REA_PACKAGE || semver.valid(metadata.version) === null) return null
  const entry = join(directory, 'scripts', 'rea.mjs')
  const reasons = []
  if (!await isFile(entry)) reasons.push('missing scripts/rea.mjs')
  const range = metadata.engines?.node
  if (typeof range !== 'string' || semver.validRange(range) === null) reasons.push('missing engines.node range')
  else if (nodeVersion && !semver.satisfies(String(nodeVersion).replace(/^v/, ''), range)) reasons.push(`Node ${nodeVersion} does not satisfy ${range}`)
  if (!nodePath || !await isFile(nodePath)) reasons.push('Node executable not found')
  return {
    root: directory,
    reaVersion: metadata.version,
    nodeRange: typeof range === 'string' ? range : null,
    nodePath,
    nodeVersion,
    entry,
    usable: reasons.length === 0,
    reason: reasons.join('; '),
  }
}

/** Scan the deterministic roots and return usable installations first. */
export async function detectExistingRea({ env = process.env, nodePath = process.execPath, nodeVersion = process.version, home = homedir(), roots, nodes } = {}) {
  const scanned = roots ?? await candidateRoots({ env, nodePath, home })
  // Prefer the plugin's own managed Node: a user's REA may need a newer Node than
  // the host process runs, and the managed one is already verified.
  const runtimes = (nodes && nodes.length ? nodes : [{ nodePath, nodeVersion }]).filter(item => item && item.nodePath)
  const candidates = []
  for (const root of scanned) {
    if (candidates.length >= MAX_CANDIDATES) break
    let best = null
    for (const runtime of runtimes) {
      const candidate = await inspectExistingRea({ root, nodePath: runtime.nodePath, nodeVersion: runtime.nodeVersion })
      if (candidate === null) break
      if (best === null) best = candidate
      if (candidate.usable) { best = candidate; break }
    }
    if (best) candidates.push(best)
  }
  const seen = new Set()
  const unique = candidates.filter(candidate => {
    const key = `${candidate.root}@${candidate.reaVersion}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((left, right) => Number(right.usable) - Number(left.usable) || semver.rcompare(left.reaVersion, right.reaVersion))
  return { nodePath, nodeVersion, scanned: scanned.length, candidates: unique }
}

/** Re-validate exactly the paths a user picked before they are written to config. */
export async function verifyAdoption({ nodePath, reaEntry, nodeVersion }) {
  if (typeof nodePath !== 'string' || typeof reaEntry !== 'string' || !nodePath || !reaEntry) throw new Error('Both nodePath and reaEntry are required')
  const entry = await realpath(reaEntry).catch(() => null)
  if (entry === null) throw new Error('reaEntry does not exist')
  // Only the package entry may be adopted; anything else is reported as layout, not identity.
  if (!entry.endsWith(`${sep}scripts${sep}rea.mjs`)) throw new Error('reaEntry must be the package scripts/rea.mjs entry')
  // entry is <node_modules>/rea-agents/scripts/rea.mjs, so the scan root is three levels up.
  const root = dirname(dirname(dirname(entry)))
  const candidate = await inspectExistingRea({ root, nodePath, nodeVersion })
  if (candidate === null) throw new Error('Not a rea-agents package')
  if (candidate.entry !== entry) throw new Error('reaEntry must be the package scripts/rea.mjs entry')
  if (!candidate.usable) throw new Error(candidate.reason)
  if (!nodeVersion) throw new Error('A Node version is required to verify the REA contract')
  return candidate
}

/** The Node range a REA package declares, for compatibility decisions. */
export async function requiredNodeRange(reaEntry) {
  const entry = await realpath(reaEntry).catch(() => null)
  if (entry === null) throw new Error('reaEntry does not exist')
  if (!entry.endsWith(`${sep}scripts${sep}rea.mjs`)) throw new Error('reaEntry must be the package scripts/rea.mjs entry')
  const metadata = JSON.parse(await readFile(join(dirname(dirname(entry)), 'package.json'), 'utf8'))
  const range = metadata?.engines?.node
  if (typeof range !== 'string' || semver.validRange(range) === null) throw new Error('This REA package declares no usable engines.node range')
  return { range, reaVersion: metadata.version }
}

/** Read one Node binary's version without inheriting developer hooks. */
async function readNodeVersion(nodePath) {
  try {
    const { stdout } = await execFile(nodePath, ['--version'], {
      timeout: 5000, maxBuffer: 4096, windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    })
    const version = stdout.trim()
    return semver.valid(version.replace(/^v/, '')) ? version : null
  } catch { return null }
}

/**
 * Node binaries installed on this machine that could run the adopted REA.
 * Only paths that can be named deterministically are probed; each one is read
 * with `<node> --version`, so a broken shim is reported as absent, not guessed.
 */
export async function detectNodes({ env = process.env, nodePath = process.execPath, home = homedir(), managed } = {}) {
  const candidates = new Map()
  const add = path => { if (typeof path === 'string' && path && !candidates.has(path) && candidates.size < 12) candidates.set(path, true) }
  add(nodePath)
  const pathSep = sep === '/' ? ':' : ';'
  for (const dir of String(env.PATH ?? '').split(pathSep)) add(join(dir, sep === '/' ? 'node' : 'node.exe'))
  for (const prefix of [join(home, '.volta', 'bin', 'node'), join(home, '.fnm', 'aliases', 'default', 'bin', 'node')]) add(prefix)
  const nvm = join(home, '.nvm', 'versions', 'node')
  if (await isDir(nvm)) {
    for (const version of (await readdir(nvm).catch(() => [])).slice(-4)) add(join(nvm, version, 'bin', 'node'))
  }
  const nodes = []
  const seen = new Set()
  for (const candidate of candidates.keys()) {
    if (!await isFile(candidate)) continue
    const real = await realpath(candidate).catch(() => candidate)
    if (seen.has(real)) continue
    const version = await readNodeVersion(candidate)
    if (!version) continue
    seen.add(real)
    nodes.push({ nodePath: candidate, nodeVersion: version })
  }
  if (managed?.nodePath && managed?.nodeVersion && !nodes.some(node => node.nodePath === managed.nodePath)) {
    nodes.unshift({ nodePath: managed.nodePath, nodeVersion: managed.nodeVersion })
  }
  return nodes
}

/**
 * Other DSH profiles that would break if the shared runtime disappeared.
 * A profile counts as a managed user when our plugin is installed and its
 * configuration carries no manual nodePath; unknown or unreadable cases are
 * reported as blockers rather than assumed safe.
 */
export async function profilesUsingManagedRuntime({ profilesRoot, currentProfile }) {
  const blockers = []
  let entries
  try { entries = await readdir(profilesRoot, { withFileTypes: true }) } catch { return blockers }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentProfile) continue
    const directory = join(profilesRoot, entry.name)
    if (!await isDir(join(directory, 'node_modules', PLUGIN_PACKAGE))) continue
    let patch = null
    try { patch = await readFile(join(directory, 'cordis.patch.yml'), 'utf8') } catch { /* treat as unknown below */ }
    if (patch === null) { blockers.push({ profile: entry.name, reason: 'configuration is unreadable' }); continue }
    if (!patch.includes(PLUGIN_PACKAGE)) continue
    // A non-empty nodePath means this profile adopted its own environment.
    const manual = /^\s+nodePath:\s*['"]?[^\s'"]+/m.test(patch)
    if (!manual) blockers.push({ profile: entry.name, reason: 'still uses the shared managed runtime' })
  }
  return blockers
}

export const PLUGIN_PACKAGE = 'dsh-reakit'

/** The profile directory this host is running, when it can be derived safely. */
export function currentProfileContext(cwd = process.cwd()) {
  const parent = dirname(cwd)
  if (parent.endsWith(`${sep}profiles`)) return { profilesRoot: parent, currentProfile: cwd.slice(parent.length + 1) }
  return { profilesRoot: null, currentProfile: null }
}
