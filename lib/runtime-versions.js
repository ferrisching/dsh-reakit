import semver from 'semver'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { downloadVerified, npmEnvironment, resolveRegistry, runProcess, setupLock, runtimeRoot } from './bootstrap.js'
import { mirrorArtifact, resolveNodeMirror, verifyMirrorShasums } from './node-mirror.js'
import { inspectInstallation, REA_NODE_RANGE } from './config.js'

const NPM_METADATA = 'https://registry.npmjs.org/rea-agents'
const NODE_INDEX = 'https://nodejs.org/dist/index.json'
const NODE_FILES = Object.freeze({
  'darwin-arm64': 'osx-arm64-tar', 'darwin-x64': 'osx-x64-tar',
  'linux-arm64': 'linux-arm64', 'linux-x64': 'linux-x64',
  'win32-arm64': 'win-arm64-zip', 'win32-x64': 'win-x64-zip',
})
const sha256 = value => createHash('sha256').update(value).digest('hex')
const stable = version => semver.valid(version) && !semver.prerelease(version)

async function fetchText(url, { signal, fetchImpl = globalThis.fetch, maxBytes = 8 * 1024 * 1024 } = {}) {
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)])
  const response = await fetchImpl(url, { redirect: 'error', signal: deadline, headers: { accept: 'application/vnd.npm.install-v1+json, application/json, text/plain' } })
  if (!response?.ok || !response.body) throw new Error(`Official release metadata failed: HTTP ${response?.status ?? 'unavailable'}`)
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Official release metadata exceeds its bounded size')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    deadline.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new Error('Official release metadata exceeds its bounded size')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchJson(url, options) {
  return JSON.parse(await fetchText(url, options))
}

export function nodeArchive(version, sha256sum, platform = process.platform, arch = process.arch) {
  if (!stable(version) || !/^[a-f0-9]{64}$/.test(sha256sum)) throw new Error('Invalid Node release or checksum')
  if (!NODE_FILES[`${platform}-${arch}`]) throw new Error(`No managed Node archive for ${platform}/${arch}`)
  const directory = `node-v${version}-${platform === 'win32' ? 'win' : platform}-${arch}`
  const filename = `${directory}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
  return { directory, filename, sha256: sha256sum, url: `https://nodejs.org/dist/v${version}/${filename}`, checksumSource: `https://nodejs.org/dist/v${version}/SHASUMS256.txt` }
}

export function selectCompatibleNode(range, releases, platform = process.platform, arch = process.arch) {
  if (semver.validRange(range) === null) throw new Error('REA declares an invalid Node engine range')
  const file = NODE_FILES[`${platform}-${arch}`]
  if (!file) return undefined
  return releases.filter(row => stable(row.version?.replace(/^v/, '')) && row.lts && Array.isArray(row.files) && row.files.includes(file) && semver.satisfies(row.version, range))
    .sort((a, b) => semver.rcompare(a.version, b.version))[0]
}

function validateCandidate(candidate, forPreparation = false) {
  const rea = candidate?.rea, node = candidate?.node
  if (!stable(rea?.version) || semver.validRange(rea.nodeRange) === null || typeof rea.integrity !== 'string' || !rea.integrity.startsWith('sha512-')) throw new Error('Invalid REA release candidate')
  const tarball = `https://registry.npmjs.org/rea-agents/-/rea-agents-${rea.version}.tgz`
  if (rea.tarball !== tarball || rea.source !== `https://www.npmjs.com/package/rea-agents/v/${rea.version}`) throw new Error('REA candidate did not come from the official npm release')
  if (!stable(node?.version) || !semver.satisfies(node.version, rea.nodeRange)) throw new Error('Selected Node is incompatible with the selected REA')
  const archive = nodeArchive(node.version, node.archive?.sha256, candidate.platform, candidate.arch)
  if (node.archive?.url !== archive.url || node.archive?.directory !== archive.directory || node.archive?.filename !== archive.filename || node.source !== `https://nodejs.org/dist/v${node.version}/`) throw new Error('Node candidate did not come from the official release')
  if (forPreparation && rea.deprecated) throw new Error('The selected REA release is marked deprecated; it will not be prepared automatically')
  return { rea: { version: rea.version, nodeRange: rea.nodeRange, tarball, integrity: rea.integrity, source: rea.source, deprecated: rea.deprecated }, node: { version: node.version, lts: node.lts, source: node.source, archive }, platform: candidate.platform, arch: candidate.arch }
}

export function validateDependencyLock(lockText, rea) {
  const parsed = JSON.parse(lockText.toString())
  if (parsed.lockfileVersion !== 3 || parsed.packages?.['']?.dependencies?.['rea-agents'] !== rea.version) throw new Error('Generated dependency lock has an invalid root')
  const entries = Object.entries(parsed.packages)
  if (entries.length < 2) throw new Error('Generated dependency lock is incomplete')
  for (const [path, entry] of entries) {
    if (!path) continue
    if (entry.link || !semver.valid(entry.version)) throw new Error(`Dependency lock contains a non-registry or invalid entry: ${path}`)
    let source
    try { source = new URL(entry.resolved) } catch { throw new Error(`Dependency lock entry has no official resolved URL: ${path}`) }
    if (source.protocol !== 'https:' || source.hostname !== 'registry.npmjs.org' || source.username || source.password || typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) throw new Error(`Dependency lock entry lacks official integrity: ${path}`)
  }
  const locked = parsed.packages['node_modules/rea-agents']
  if (locked?.version !== rea.version || locked.resolved !== rea.tarball || locked.integrity !== rea.integrity) throw new Error('Generated dependency lock differs from the reviewed REA release')
  return parsed
}

/** Read-only network inspection. No directory is created and nothing is installed. */
export async function checkRuntimeUpdates({ currentReaVersion, currentNodeVersion, currentReaNodeRange = REA_NODE_RANGE, platform = process.platform, arch = process.arch, signal, fetchImpl = globalThis.fetch } = {}) {
  const [metadata, nodes] = await Promise.all([
    fetchJson(NPM_METADATA, { signal, fetchImpl }),
    fetchJson(NODE_INDEX, { signal, fetchImpl, maxBytes: 4 * 1024 * 1024 }),
  ])
  const version = metadata['dist-tags']?.latest
  const release = metadata.versions?.[version]
  if (!stable(version) || release?.name !== 'rea-agents' || release.version !== version || semver.validRange(release.engines?.node) === null || typeof release.dist?.integrity !== 'string') throw new Error('Official npm metadata has no usable stable REA release')
  const node = selectCompatibleNode(release.engines.node, nodes, platform, arch)
  if (!node) return { current: { reaVersion: currentReaVersion, nodeVersion: currentNodeVersion }, candidate: null, reason: `No supported LTS Node release satisfies REA ${version} engines ${release.engines.node} on ${platform}/${arch}` }
  const nodeVersion = node.version.replace(/^v/, '')
  const archiveWithoutHash = nodeArchive(nodeVersion, '0'.repeat(64), platform, arch)
  const checksumText = await fetchText(archiveWithoutHash.checksumSource, { signal, fetchImpl, maxBytes: 128 * 1024 })
  const escapedName = archiveWithoutHash.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...checksumText.matchAll(new RegExp(`^([a-f0-9]{64})  ${escapedName}$`, 'gm'))]
  if (matches.length !== 1) throw new Error('Node checksum list must contain exactly one exact archive entry')
  const checksum = matches[0][1]
  const candidate = validateCandidate({
    rea: { version, nodeRange: release.engines.node, tarball: release.dist.tarball, integrity: release.dist.integrity, source: `https://www.npmjs.com/package/rea-agents/v/${version}`, deprecated: release.deprecated },
    node: { version: nodeVersion, lts: node.lts, source: `https://nodejs.org/dist/v${nodeVersion}/`, archive: { ...archiveWithoutHash, sha256: checksum } },
    platform, arch,
  })
  const baseline = selectCompatibleNode(currentReaNodeRange, nodes, platform, arch)
  return {
    current: { reaVersion: currentReaVersion, nodeVersion: currentNodeVersion, nodeRange: currentReaNodeRange }, candidate,
    updateAvailable: semver.gt(version, currentReaVersion) || semver.gt(nodeVersion, currentNodeVersion.replace(/^v/, '')),
    reaUpdateAvailable: semver.gt(version, currentReaVersion), nodeUpdateAvailable: semver.gt(nodeVersion, currentNodeVersion.replace(/^v/, '')),
    newerNodeRequiresReaUpgrade: Boolean(baseline && semver.gt(nodeVersion, baseline.version) && !semver.gt(version, currentReaVersion)),
  }
}

function dynamicLayout(root, candidate, lockSha256) {
  const directory = join(root, `node-${candidate.node.version}-rea-${candidate.rea.version}-${candidate.platform}-${candidate.arch}-${lockSha256.slice(0, 12)}`)
  return {
    directory, lockSha256,
    nodePath: join(directory, candidate.node.archive.directory, ...(candidate.platform === 'win32' ? ['node.exe'] : ['bin', 'node'])),
    reaEntry: join(directory, 'engine', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
  }
}

async function stat(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

async function existingDynamic(layout, candidate, settings, inspect) {
  const info = await stat(layout.directory)
  if (!info) return undefined
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Managed version runtime must be a regular directory, not a symlink')
  const ready = JSON.parse(await readFile(join(layout.directory, 'ready.json'), 'utf8'))
  if (ready.formatVersion !== 3 || ready.lockSha256 !== layout.lockSha256 || ready.reaVersion !== candidate.rea.version || ready.nodeVersion !== candidate.node.version || ready.nodeRange !== candidate.rea.nodeRange || ready.reaIntegrity !== candidate.rea.integrity || ready.nodeArchiveSha256 !== candidate.node.archive.sha256 || ready.platform !== candidate.platform || ready.arch !== candidate.arch) throw new Error('Existing version runtime marker differs; it was preserved')
  const lock = await readFile(join(layout.directory, 'engine', 'package-lock.json'))
  if (sha256(lock) !== layout.lockSha256) throw new Error('Existing version runtime dependency lock digest changed')
  validateDependencyLock(lock, candidate.rea)
  for (const [path, digest] of [[layout.nodePath, ready.nodeSha256], [layout.reaEntry, ready.entrySha256], [join(layout.directory, 'engine', 'package-lock.json'), ready.lockSha256]]) {
    if (!digest || sha256(await readFile(path)) !== digest) throw new Error('Existing version runtime digest differs; it was preserved')
  }
  return inspect({ ...settings, nodePath: layout.nodePath, reaEntry: layout.reaEntry }, { reaVersion: candidate.rea.version, nodeRange: candidate.rea.nodeRange })
}

/** Offline activation check for a previously published dynamic generation. */
/** Derive the split directories from the two configured paths. */
export function splitDirectories(nodePath, reaEntry) {
  // <root>/node/<id>/bin/node  →  <root>/node/<id>
  // <root>/engine/<id>/node_modules/rea-agents/scripts/rea.mjs → <root>/engine/<id>
  return {
    nodeDirectory: dirname(dirname(nodePath)),
    engineDirectory: dirname(dirname(dirname(dirname(reaEntry)))),
  }
}

/** Validate a split (node/ + engine/) managed runtime, or return null for legacy. */
export async function inspectSplitManagedRuntime(settings, inspect = inspectInstallation) {
  const root = runtimeRoot(settings)
  const nodeRoot = join(root, 'node') + sep
  const engineRoot = join(root, 'engine') + sep
  if (!String(settings.nodePath).startsWith(nodeRoot) || !String(settings.reaEntry).startsWith(engineRoot)) return null
  const { nodeDirectory, engineDirectory } = splitDirectories(settings.nodePath, settings.reaEntry)
  if (!nodeDirectory.startsWith(nodeRoot) || !engineDirectory.startsWith(engineRoot)) throw new Error('Split runtime paths escape the managed root')
  const node = JSON.parse(await readFile(join(nodeDirectory, 'ready.json'), 'utf8'))
  const engine = JSON.parse(await readFile(join(engineDirectory, 'ready.json'), 'utf8'))
  if (node.formatVersion !== 1 || engine.formatVersion !== 1) throw new Error('Split runtime marker format is unknown')
  if (engine.reaVersion !== settings.managedReaVersion) throw new Error('Split runtime REA version does not match the selected release')
  const nodeVersion = `v${node.nodeVersion}`
  if (!semver.satisfies(node.nodeVersion, settings.managedNodeRange)) throw new Error('Split runtime Node version does not satisfy the selected range')
  if (node.platform !== process.platform || node.arch !== process.arch) throw new Error('Split runtime was prepared for another platform')
  const lock = await readFile(join(engineDirectory, 'package-lock.json'))
  if (sha256(lock) !== engine.lockSha256) throw new Error('Split runtime dependency lock digest changed')
  const [nodePath, reaEntry] = await Promise.all([realpath(settings.nodePath), realpath(settings.reaEntry)])
  if (sha256(await readFile(nodePath)) !== node.nodeSha256 && node.nodeSha256) throw new Error('Split runtime Node digest changed')
  if (engine.entrySha256 && sha256(await readFile(reaEntry)) !== engine.entrySha256) throw new Error('Split runtime REA entry digest changed')
  const checked = await inspect({ ...settings, nodePath, reaEntry }, { reaVersion: settings.managedReaVersion, nodeRange: settings.managedNodeRange })
  if (checked.reaVersion !== engine.reaVersion || checked.nodeVersion !== nodeVersion) throw new Error('Split runtime version differs from its markers')
  return { ...checked, directory: nodeDirectory, engineDirectory, lockSha256: engine.lockSha256 }
}

export async function inspectManagedRuntime(settings, inspect = inspectInstallation) {
  const split = await inspectSplitManagedRuntime(settings, inspect)
  if (split) return split
  if (!isAbsolute(settings.nodePath || '') || !isAbsolute(settings.reaEntry || '') || !settings.managedReaVersion || !settings.managedNodeRange || semver.valid(settings.managedReaVersion) === null || semver.validRange(settings.managedNodeRange) === null) throw new Error('Dynamic runtime paths and managed version metadata must be complete')
  const generation = dirname(dirname(dirname(dirname(dirname(settings.reaEntry)))))
  const info = await stat(generation)
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error('Dynamic runtime generation must be a regular directory')
  const ready = JSON.parse(await readFile(join(generation, 'ready.json'), 'utf8'))
  if (ready.formatVersion !== 3 || ready.reaVersion !== settings.managedReaVersion || ready.nodeRange !== settings.managedNodeRange || ready.platform !== process.platform || ready.arch !== process.arch || typeof ready.lockSha256 !== 'string' || typeof ready.reaIntegrity !== 'string') throw new Error('Dynamic runtime ready marker does not match the selected release')
  const lockPath = join(generation, 'engine', 'package-lock.json')
  const lock = await readFile(lockPath)
  if (sha256(lock) !== ready.lockSha256) throw new Error('Dynamic runtime dependency lock digest changed')
  validateDependencyLock(lock, { version: settings.managedReaVersion, tarball: `https://registry.npmjs.org/rea-agents/-/rea-agents-${settings.managedReaVersion}.tgz`, integrity: ready.reaIntegrity })
  const canonicalGeneration = await realpath(generation)
  const canonicalEntry = await realpath(join(generation, 'engine', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'))
  const artifact = nodeArchive(ready.nodeVersion, ready.nodeArchiveSha256, process.platform, process.arch)
  const expectedLayout = dynamicLayout(runtimeRoot(settings), { rea: { version: settings.managedReaVersion }, node: { version: ready.nodeVersion, archive: artifact }, platform: process.platform, arch: process.arch }, ready.lockSha256)
  if (canonicalGeneration !== await realpath(expectedLayout.directory)) throw new Error('Dynamic runtime generation escapes the configured managed root')
  const expectedNodePath = await realpath(join(generation, artifact.directory, ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node'])))
  const [nodePath, reaEntry] = await Promise.all([realpath(settings.nodePath), realpath(settings.reaEntry)])
  if (nodePath !== expectedNodePath || !nodePath.startsWith(canonicalGeneration + sep) || reaEntry !== canonicalEntry || !canonicalEntry.startsWith(canonicalGeneration + sep)) throw new Error('Dynamic runtime paths escape their published generation')
  if (sha256(await readFile(nodePath)) !== ready.nodeSha256 || sha256(await readFile(reaEntry)) !== ready.entrySha256) throw new Error('Dynamic runtime executable or entry digest changed')
  const checked = await inspect({ ...settings, nodePath, reaEntry }, { reaVersion: settings.managedReaVersion, nodeRange: settings.managedNodeRange })
  if (checked.reaVersion !== ready.reaVersion || checked.nodeVersion !== `v${ready.nodeVersion}` || checked.nodeRange !== ready.nodeRange) throw new Error('Dynamic runtime version differs from its ready marker')
  return { ...checked, directory: generation, lockSha256: ready.lockSha256 }
}

/** Stage, verify and atomically publish an immutable generation. Never replace an existing one. */
export async function prepareRuntimeCandidate(value, settings = {}, options = {}) {
  const candidate = validateCandidate(value, true)
  const { inspect = inspectInstallation, fetchImpl = globalThis.fetch, run = runProcess, log } = options
  const root = settings.runtimeDir
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('A resolved absolute managed runtime root is required')
  const assertPrivateRoot = async () => {
    const info = await stat(root)
    if (info && (info.isSymbolicLink() || !info.isDirectory() || (candidate.platform !== 'win32' && ((info.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))))) throw new Error('Managed runtime root is not private')
  }
  await assertPrivateRoot()
  const timeoutMs = settings.setupTimeoutMs ?? 600_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid setupTimeoutMs')
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)])
  await mkdir(root, { recursive: true, mode: 0o700 })
  await assertPrivateRoot()
  const release = await setupLock(root, signal, log)
  try {
    const stage = await mkdtemp(join(root, '.version-'))
    log?.(`Preparing REA ${candidate.rea.version} with Node ${candidate.node.version} in an isolated staging directory`)
    const archive = join(stage, candidate.node.archive.filename)
    await downloadVerified(candidate.node.archive, archive, { signal, fetchImpl })
    const tar = candidate.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
    const nodePath = join(stage, candidate.node.archive.directory, ...(candidate.platform === 'win32' ? ['node.exe'] : ['bin', 'node']))
    const reaEntry = join(stage, 'engine', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs')
    await run(tar, ['-xf', archive, '-C', stage], { signal, env: npmEnvironment(dirname(nodePath), join(root, 'npm-cache')) })
    const engine = join(stage, 'engine')
    await mkdir(engine)
    await writeFile(join(engine, 'package.json'), JSON.stringify({ name: 'dsh-reakit-local-engine', version: '0.0.0', private: true, dependencies: { 'rea-agents': candidate.rea.version } }, null, 2) + '\n', { flag: 'wx' })
    const userConfig = join(stage, 'npm-user.config'), globalConfig = join(stage, 'npm-global.config')
    await writeFile(userConfig, '', { flag: 'wx' }); await writeFile(globalConfig, '', { flag: 'wx' })
    const npm = join(stage, candidate.node.archive.directory, ...(candidate.platform === 'win32' ? ['node_modules', 'npm', 'bin', 'npm-cli.js'] : ['lib', 'node_modules', 'npm', 'bin', 'npm-cli.js']))
    const registry = resolveRegistry(settings.npmRegistry)
    const npmArgs = [npm, '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', `--registry=${registry}`, `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`]
    const env = npmEnvironment(dirname(nodePath), join(root, 'npm-cache'), process.env, registry)
    log?.('Resolving an exact, integrity-locked dependency graph; lifecycle scripts are disabled')
    await run(nodePath, [npm, 'install', '--package-lock-only', ...npmArgs.slice(1)], { cwd: engine, env, signal })
    const lock = await readFile(join(engine, 'package-lock.json'))
    validateDependencyLock(lock, candidate.rea)
    const lockSha256 = sha256(lock), layout = dynamicLayout(root, candidate, lockSha256)
    const current = await existingDynamic(layout, candidate, settings, inspect)
    if (current) return current
    log?.('Installing the locked dependencies without running package lifecycle scripts')
    await run(nodePath, [npm, 'ci', ...npmArgs.slice(1)], { cwd: engine, env, signal })
    const stagedSettings = { ...settings, nodePath, reaEntry }
    const checked = await inspect(stagedSettings, { reaVersion: candidate.rea.version, nodeRange: candidate.rea.nodeRange })
    if (checked.reaVersion !== candidate.rea.version || checked.nodeVersion !== `v${candidate.node.version}`) throw new Error('Prepared runtime version differs from the confirmed candidate')
    const ready = { formatVersion: 3, reaVersion: candidate.rea.version, nodeVersion: candidate.node.version, nodeRange: candidate.rea.nodeRange, platform: candidate.platform, arch: candidate.arch, nodeArchiveSha256: candidate.node.archive.sha256, lockSha256,
      nodeSha256: sha256(await readFile(nodePath)), entrySha256: sha256(await readFile(reaEntry)), reaIntegrity: candidate.rea.integrity, createdAt: new Date().toISOString() }
    await writeFile(join(stage, 'ready.json'), JSON.stringify(ready, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
    if (dirname(stage) !== root || dirname(layout.directory) !== root || await stat(layout.directory)) throw new Error('Version runtime publication target changed; existing generation was preserved')
    await rename(stage, layout.directory)
    log?.('Candidate runtime is ready; the previous runtime remains unchanged')
    return { ...await existingDynamic(layout, candidate, settings, inspect), directory: layout.directory, lockSha256 }
  } finally { await release() }
}
