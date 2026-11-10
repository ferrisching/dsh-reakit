import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, writeFile, mkdir, mkdtemp, readdir, rename, lstat, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { inspectInstallation, REA_VERSION } from './config.js'

import { OFFICIAL_NODE_DIST } from './node-dist.js'
import { mirrorArtifact, resolveNodeMirror, verifyMirrorShasums } from './node-mirror.js'

export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
export const NODE_VERSION = '24.22.1'
export const ENGINE_LOCK_SHA256 = '8dc59ed24940902f01740d61f35904562e0adac23ce970a09cf6bb59651d082f'
export const NODE_ARCHIVES = Object.freeze({
  'darwin-arm64': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  'darwin-x64': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  'linux-arm64': '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
  'linux-x64': 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
  'win32-arm64': 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171',
  'win32-x64': 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
})
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

export function nodeArtifact(platform = process.platform, arch = process.arch) {
  const digest = NODE_ARCHIVES[`${platform}-${arch}`]
  if (!digest) throw new Error(`Automatic REA setup does not support ${platform}/${arch}; supply nodePath and reaEntry`)
  const directory = `node-v${NODE_VERSION}-${platform === 'win32' ? 'win' : platform}-${arch}`
  const filename = `${directory}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
  return {
    directory, filename, sha256: digest,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`,
    checksumSource: `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
  }
}

export function runtimeRoot(settings = {}, env = process.env, home = homedir()) {
  const path = settings.runtimeDir || join(env.DSH_HOME || join(home, '.dsh'), 'dsh-reakit', 'runtime')
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('runtimeDir must be an absolute local path')
  return resolve(path)
}

export function runtimeLayout(root, platform = process.platform, arch = process.arch) {
  const artifact = nodeArtifact(platform, arch)
  // Node and REA live in sibling trees: dropping the Node part only costs a
  // re-download, and an installed engine can be paired with another Node.
  const nodeDirectory = join(root, 'node', `${platform}-${arch}-${NODE_VERSION}-${artifact.sha256.slice(0, 12)}`)
  const engineDirectory = join(root, 'engine', `rea${REA_VERSION}-${ENGINE_LOCK_SHA256.slice(0, 12)}`)
  return {
    platform, arch, artifact,
    nodeDirectory, engineDirectory,
    nodePath: join(nodeDirectory, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node'])),
    reaEntry: join(engineDirectory, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
    nodeMarker: join(nodeDirectory, 'ready.json'),
    engineMarker: join(engineDirectory, 'ready.json'),
  }
}

/** Avoid project/user npm configuration, Node preloads and ambient credentials. */
/** Only an https registry without embedded credentials is accepted. */
export function resolveRegistry(value) {
  if (value === undefined || value === null || value === '') return OFFICIAL_REGISTRY
  let url
  try { url = new URL(String(value)) } catch { throw new Error('npmRegistry must be an absolute https URL') }
  if (url.protocol !== 'https:') throw new Error('npmRegistry must use https')
  if (url.username || url.password) throw new Error('npmRegistry must not embed credentials')
  if (url.search || url.hash) throw new Error('npmRegistry must not carry a query or fragment')
  return url.toString()
}

export function npmEnvironment(nodeDirectory, cache, env = process.env, registry = OFFICIAL_REGISTRY) {
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (!/^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|SystemRoot|WINDIR|LANG|LC_ALL|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)) continue
    result[key] = value
  }
  result.PATH = `${nodeDirectory}${process.platform === 'win32' ? ';' : ':'}${env.PATH || ''}`
  result.NODE_OPTIONS = ''
  result.NODE_PATH = ''
  result.npm_config_cache = cache
  result.npm_config_registry = registry
  result.npm_config_ignore_scripts = 'true'
  result.npm_config_audit = 'false'
  result.npm_config_fund = 'false'
  return result
}

/** Resolve only after the owned child has exited, including abort/timeout paths. */
export function runProcess(command, args, { cwd, env, signal } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failure, killTimer
    const stop = (error) => {
      failure ??= error
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000)
      killTimer.unref()
    }
    const abort = () => stop(signal.reason ?? new Error('REA setup canceled'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const capture = (channel) => (chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 1024 * 1024) return stop(new Error('REA setup process output exceeded 1 MiB'))
      if (channel === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    child.stdout.on('data', capture('stdout'))
    child.stderr.on('data', capture('stderr'))
    child.on('error', (error) => { failure ??= error })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(`REA setup subprocess failed (${code}): ${stderr.slice(-3000)}`))
      resolve({ stdout, stderr })
    })
  })
}

export async function downloadVerified(artifact, destination, { signal, fetchImpl = globalThis.fetch } = {}) {
  signal?.throwIfAborted()
  const response = await fetchImpl(artifact.url, { redirect: 'error', signal })
  if (!response.ok || !response.body) throw new Error(`Node download failed (HTTP ${response.status})`)
  if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) throw new Error('Node download exceeds 128 MiB')
  const file = await open(destination, 'wx', 0o600)
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error('Node download exceeds 128 MiB')
      hash.update(chunk)
      await file.writeFile(chunk)
    }
  } finally { await file.close() }
  const observed = hash.digest('hex')
  if (observed !== artifact.sha256) throw new Error('Official Node archive SHA-256 mismatch; nothing activated')
  return { bytes, sha256: observed }
}

async function maybeStat(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

/** Remove abandoned staging directories from earlier failed installs. */
export async function cleanupStaging(root, { olderThanMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const removed = []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return removed }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.setup-')) continue
    const path = join(root, entry.name)
    const info = await stat(path).catch(() => null)
    if (!info || now - info.mtimeMs < olderThanMs) continue
    await rm(path, { recursive: true, force: true }).catch(() => {})
    removed.push(entry.name)
  }
  return removed
}

export async function setupLock(root, signal, log) {
  const path = join(root, '.setup.lock')
  const token = randomUUID()
  for (;;) {
    signal.throwIfAborted()
    try {
      const file = await open(path, 'wx', 0o600)
      await file.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }))
      await file.close()
      return async () => {
        // Only this invocation's exact lock may be unlinked; preserve foreign work.
        if (dirname(path) !== root || JSON.parse(await readFile(path, 'utf8')).token !== token) throw new Error('REA setup lock ownership changed')
        await unlink(path)
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(path, 'utf8')) } catch { /* Another process may still be writing its lock. */ }
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0) } catch (error) {
          if (error.code === 'ESRCH') throw new Error(`Interrupted REA setup lock at ${path}; verify PID ${owner.pid} is gone before removing only this lock`)
        }
      }
      log?.('Waiting for another REA initialization to finish')
      await delay(500, undefined, { signal })
    }
  }
}

/** A published engine that still verifies, so only the Node part needs work. */
async function readyEngine(layout) {
  try {
    const marker = JSON.parse(await readFile(layout.engineMarker, 'utf8'))
    if (marker.formatVersion !== 1 || marker.reaVersion !== REA_VERSION || marker.lockSha256 !== ENGINE_LOCK_SHA256) return false
    if (!marker.entrySha256 || sha256(await readFile(layout.reaEntry)) !== marker.entrySha256) return false
    return true
  } catch { return false }
}

async function existingInstallation(layout, settings, inspect) {
  const node = await maybeStat(layout.nodeDirectory)
  if (!node) return undefined
  if (node.isSymbolicLink() || !node.isDirectory()) throw new Error('Managed Node directory must be a regular owned directory, not a symlink')
  const engine = await maybeStat(layout.engineDirectory)
  if (!engine) throw new Error('Managed Node part exists without its REA engine; re-run setup to restore it')
  if (engine.isSymbolicLink() || !engine.isDirectory()) throw new Error('Managed REA engine must be a regular owned directory, not a symlink')
  const nodeMarker = JSON.parse(await readFile(layout.nodeMarker, 'utf8'))
  const engineMarker = JSON.parse(await readFile(layout.engineMarker, 'utf8'))
  if (nodeMarker.formatVersion !== 1 || nodeMarker.nodeVersion !== NODE_VERSION || nodeMarker.platform !== layout.platform || nodeMarker.arch !== layout.arch || nodeMarker.archiveSha256 !== layout.artifact.sha256) throw new Error('Managed Node marker does not match this plugin; existing directory was preserved')
  if (engineMarker.formatVersion !== 1 || engineMarker.reaVersion !== REA_VERSION || engineMarker.lockSha256 !== ENGINE_LOCK_SHA256) throw new Error('Managed engine marker does not match this plugin; existing directory was preserved')
  for (const [path, digest] of [[layout.nodePath, nodeMarker.nodeSha256], [layout.reaEntry, engineMarker.entrySha256]]) {
    if (!digest || sha256(await readFile(path)) !== digest) throw new Error('Managed REA runtime file digest changed; existing directory was preserved')
  }
  return inspect({ ...settings, nodePath: layout.nodePath, reaEntry: layout.reaEntry })
}

/** Called once on activation; subsequent starts use the verified local generation offline. */
export async function ensureRuntime(settings = {}, options = {}) {
  const { platform = process.platform, arch = process.arch, inspect = inspectInstallation, install = installRuntime, log } = options
  const root = runtimeRoot(settings)
  const rootStat = await maybeStat(root)
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (platform !== 'win32' && ((rootStat.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()))))) {
    throw new Error('Managed REA root must be a private directory owned by the current user, not a symlink')
  }
  const layout = runtimeLayout(root, platform, arch)
  const timeoutMs = settings.setupTimeoutMs ?? 600_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid setupTimeoutMs')
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)])
  const existing = await existingInstallation(layout, settings, inspect)
  if (existing) { log?.('Using verified offline REA runtime'); return existing }
  if (settings.autoSetup === false) throw new Error('REA runtime is not installed and autoSetup=false; enable autoSetup once or supply nodePath and reaEntry')
  signal.throwIfAborted()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const createdRoot = await lstat(root)
  if (createdRoot.isSymbolicLink() || !createdRoot.isDirectory() || (platform !== 'win32' && ((createdRoot.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && createdRoot.uid !== process.getuid())))) {
    throw new Error('Managed REA root changed or is not private after directory creation')
  }
  const release = await setupLock(root, signal, log)
  try {
    const current = await existingInstallation(layout, settings, inspect)
    if (current) return current
    // Abandoned staging trees from crashed installs are hundreds of MB each.
    const abandoned = await cleanupStaging(root)
    if (abandoned.length) log?.(`Removed ${abandoned.length} abandoned staging director${abandoned.length === 1 ? 'y' : 'ies'}`)
    const reuseEngine = await readyEngine(layout)
    const stage = await mkdtemp(join(root, '.setup-'))
    log?.(reuseEngine ? `Preparing Node ${NODE_VERSION}; the installed REA ${REA_VERSION} is reused` : `Preparing Node ${NODE_VERSION} and REA ${REA_VERSION}; first activation needs network access`)
    // Failed staging data is retained for diagnosis, never published or marked ready.
    const staged = {
      ...layout,
      nodeDirectory: join(stage, 'node'),
      engineDirectory: reuseEngine ? layout.engineDirectory : join(stage, 'engine'),
      nodePath: join(stage, 'node', ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node'])),
      reaEntry: reuseEngine ? layout.reaEntry : join(stage, 'engine', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
      nodeMarker: join(stage, 'node', 'ready.json'),
      engineMarker: reuseEngine ? layout.engineMarker : join(stage, 'engine', 'ready.json'),
      reuseEngine,
    }
    await install(staged, { ...options, root, platform, arch, signal, reuseEngine, registry: resolveRegistry(settings.npmRegistry), nodeMirror: resolveNodeMirror(settings.nodeMirror) })
    const checked = await inspect({ ...settings, nodePath: staged.nodePath, reaEntry: staged.reaEntry })
    if (checked.nodeVersion !== `v${NODE_VERSION}` || checked.reaVersion !== REA_VERSION) throw new Error('Prepared runtime version differs from the pinned release')
    await writeFile(staged.nodeMarker, JSON.stringify({
      formatVersion: 1, nodeVersion: NODE_VERSION, platform, arch,
      archiveSha256: layout.artifact.sha256, nodeSha256: sha256(await readFile(staged.nodePath)),
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    if (!reuseEngine) await writeFile(staged.engineMarker, JSON.stringify({
      formatVersion: 1, reaVersion: REA_VERSION, lockSha256: ENGINE_LOCK_SHA256,
      entrySha256: sha256(await readFile(staged.reaEntry)), createdAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
    // Both checked absolute paths are children of this root; never replace an existing part.
    if (dirname(staged.nodeDirectory) !== stage) throw new Error('Managed runtime layout changed before publication')
    if (!reuseEngine && dirname(staged.engineDirectory) !== stage) throw new Error('Managed runtime layout changed before publication')
    if (dirname(dirname(layout.nodeDirectory)) !== root || dirname(dirname(layout.engineDirectory)) !== root) throw new Error('Managed runtime publication target changed')
    await mkdir(dirname(layout.nodeDirectory), { recursive: true })
    await mkdir(dirname(layout.engineDirectory), { recursive: true })
    if (await maybeStat(layout.nodeDirectory)) throw new Error('Managed Node target already exists; refusing to overwrite')
    if (!reuseEngine && await maybeStat(layout.engineDirectory)) throw new Error('Managed engine target already exists; refusing to overwrite')
    if (!reuseEngine) await rename(staged.engineDirectory, layout.engineDirectory)
    try {
      await rename(staged.nodeDirectory, layout.nodeDirectory)
    } catch (error) {
      // Never leave a half-published runtime behind.
      await rm(layout.engineDirectory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    // The two parts were published by rename; the staging shell is now empty.
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    log?.('REA initialization complete; connecting tools')
    return await existingInstallation(layout, settings, inspect)
  } finally { await release() }
}

async function installRuntime(layout, { root, platform, signal, fetchImpl = globalThis.fetch, run = runProcess, log, reuseEngine = false, registry = OFFICIAL_REGISTRY, nodeMirror = OFFICIAL_NODE_DIST }) {
  const work = join(layout.nodeDirectory, '..')
  await mkdir(layout.nodeDirectory, { recursive: true })
  const artifact = mirrorArtifact(layout.artifact, nodeMirror, NODE_VERSION)
  const archive = join(work, artifact.filename)
  await downloadVerified(artifact, archive, { signal, fetchImpl })
  // A mirror must agree with the pinned digest, not just serve some bytes.
  await verifyMirrorShasums({ artifact, fetchImpl, signal })
  const tool = platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  const extracted = join(work, 'extract')
  await mkdir(extracted, { recursive: true })
  await run(tool, ['-xf', archive, '-C', extracted], { signal, env: npmEnvironment(join(extracted, 'bin'), join(root, 'npm-cache')) })
  // The archive contains one top-level directory; the split layout keeps the
  // extracted tree itself, so `<node>/bin/node` is the published path.
  await rm(layout.nodeDirectory, { recursive: true, force: true })
  await rename(join(extracted, layout.artifact.directory), layout.nodeDirectory)
  await rm(extracted, { recursive: true, force: true })
  await rm(archive, { force: true })
  const engine = layout.engineDirectory
  if (reuseEngine) return
  await mkdir(engine, { recursive: true })
  const lock = await readFile(new URL('../assets/engine/dependencies.lock.json', import.meta.url))
  if (sha256(lock) !== ENGINE_LOCK_SHA256) throw new Error('Bundled REA dependency lock checksum mismatch')
  const manifest = await readFile(new URL('../assets/engine/package.json', import.meta.url))
  const parsed = JSON.parse(manifest)
  if (parsed.dependencies?.['rea-agents'] !== REA_VERSION || parsed.private !== true) throw new Error('Invalid bundled engine manifest')
  await writeFile(join(engine, 'package.json'), manifest, { flag: 'wx' })
  await writeFile(join(engine, 'package-lock.json'), lock, { flag: 'wx' })
  const userConfig = join(work, 'npm-user.config')
  const globalConfig = join(work, 'npm-global.config')
  await writeFile(userConfig, '', { flag: 'wx' })
  await writeFile(globalConfig, '', { flag: 'wx' })
  const npm = join(layout.nodeDirectory, ...(platform === 'win32' ? ['node_modules', 'npm', 'bin', 'npm-cli.js'] : ['lib', 'node_modules', 'npm', 'bin', 'npm-cli.js']))
  log?.('Installing integrity-locked REA dependencies, including optional packages; lifecycle scripts remain disabled')
  await run(layout.nodePath, [npm, 'ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', `--registry=${registry}`, `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`], {
    cwd: engine, env: npmEnvironment(dirname(layout.nodePath), join(root, 'npm-cache'), process.env, registry), signal,
  })
}
