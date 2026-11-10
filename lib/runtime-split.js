// Split runtime layout: the Node distribution and the REA install live side by
// side so dropping the Node part only costs a re-download, never the REA tree.
//
//   runtime/node/<platform>-<arch>-<node>-<sha12>/   extracted Node + ready.json
//   runtime/engine/<rea>-<lock12>/                   npm ci install + ready.json
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const maybeStat = async path => { try { return await stat(path) } catch { return null } }

export function splitPaths(root, { platform, arch, nodeVersion, archiveSha256, reaVersion, lockSha256, artifact }) {
  const nodeId = `${platform}-${arch}-${nodeVersion}-${String(archiveSha256).slice(0, 12)}`
  const engineId = `rea${reaVersion}-${String(lockSha256).slice(0, 12)}`
  const nodeDirectory = join(root, 'node', nodeId)
  const engineDirectory = join(root, 'engine', engineId)
  const nodeBin = platform === 'win32' ? ['node.exe'] : ['bin', 'node']
  return {
    nodeId, engineId, nodeDirectory, engineDirectory,
    nodePath: join(nodeDirectory, ...nodeBin),
    reaEntry: join(engineDirectory, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
    nodeMarker: join(nodeDirectory, 'ready.json'),
    engineMarker: join(engineDirectory, 'ready.json'),
  }
}

async function readMarker(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

/** Both halves present, marked and internally consistent. */
export async function readSplitRuntime(paths, { nodeVersion, reaVersion, lockSha256, archiveSha256 } = {}) {
  const node = await readMarker(paths.nodeMarker)
  const engine = await readMarker(paths.engineMarker)
  if (!node || !engine) return null
  if (node.formatVersion !== 1 || engine.formatVersion !== 1) return null
  if (nodeVersion && node.nodeVersion !== nodeVersion) return null
  if (reaVersion && engine.reaVersion !== reaVersion) return null
  if (lockSha256 && engine.lockSha256 !== lockSha256) return null
  if (archiveSha256 && node.archiveSha256 !== archiveSha256) return null
  const nodeStat = await maybeStat(paths.nodePath)
  if (!nodeStat?.isFile()) return null
  const entry = await maybeStat(paths.reaEntry)
  if (!entry?.isFile()) return null
  return { node, engine, paths }
}

/** Verify a Node binary by running it, refusing inherited preload hooks. */
export async function verifySplitNode(paths, { run }) {
  const { stdout } = await run(paths.nodePath, ['--version'], { timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } })
  return stdout.trim()
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyTree(source, target)
    else if (entry.isSymbolicLink()) await copyFile(source, target)
    else if (entry.isFile()) await copyFile(source, target)
  }
}

/**
 * Convert one legacy `node-*` generation into the split layout.
 * Copies first, verifies by reading the binary and the package, and only then
 * removes the legacy directory, so a failure leaves the original untouched.
 */
export async function splitLegacyGeneration({ root, generation, platform, arch, run, verify = true }) {
  const ready = await readMarker(join(generation, 'ready.json'))
  if (!ready) throw new Error(`No ready marker in ${generation}`)
  const artifactDir = (await readdir(generation)).find(name => name.startsWith('node-'))
  if (!artifactDir) throw new Error('No extracted Node directory in the generation')
  const archiveName = (await readdir(generation)).find(name => name.endsWith('.tar.gz'))
  const archiveSha256 = archiveName ? sha256(await readFile(join(generation, archiveName))) : ready.nodeArchiveSha256
  const paths = splitPaths(root, {
    platform, arch,
    nodeVersion: ready.nodeVersion,
    archiveSha256,
    reaVersion: ready.reaVersion,
    lockSha256: ready.lockSha256,
    artifact: { directory: artifactDir },
  })
  const staging = join(root, `.setup-split-${Date.now()}`)
  const stagedNode = join(staging, 'node')
  const stagedEngine = join(staging, 'engine')
  await mkdir(staging, { recursive: true })
  try {
    await copyTree(join(generation, artifactDir), stagedNode)
    await copyTree(join(generation, 'engine'), stagedEngine)
    const stagedPaths = { ...paths, nodeDirectory: stagedNode, engineDirectory: stagedEngine,
      nodePath: join(stagedNode, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node'])),
      reaEntry: join(stagedEngine, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs') }
    const nodeVersion = verify ? await verifySplitNode(stagedPaths, { run }) : `v${ready.nodeVersion}`
    if (nodeVersion !== `v${ready.nodeVersion}`) throw new Error(`Staged Node reports ${nodeVersion}, expected v${ready.nodeVersion}`)
    const manifest = JSON.parse(await readFile(join(stagedEngine, 'node_modules', 'rea-agents', 'package.json'), 'utf8'))
    if (manifest.name !== 'rea-agents' || manifest.version !== ready.reaVersion) throw new Error('Staged REA package does not match the marker')
    await writeFile(join(stagedNode, 'ready.json'), JSON.stringify({
      formatVersion: 1, nodeVersion: ready.nodeVersion, platform, arch, archiveSha256, createdAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await writeFile(join(stagedEngine, 'ready.json'), JSON.stringify({
      formatVersion: 1, reaVersion: ready.reaVersion, lockSha256: ready.lockSha256,
      entrySha256: sha256(await readFile(stagedPaths.reaEntry)), createdAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await mkdir(join(root, 'node'), { recursive: true })
    await mkdir(join(root, 'engine'), { recursive: true })
    if (await maybeStat(paths.nodeDirectory)) throw new Error('Node target already exists; refusing to overwrite')
    if (await maybeStat(paths.engineDirectory)) throw new Error('Engine target already exists; refusing to overwrite')
    await rename(stagedNode, paths.nodeDirectory)
    await rename(stagedEngine, paths.engineDirectory)
    const verified = await readSplitRuntime(paths, { nodeVersion: ready.nodeVersion, reaVersion: ready.reaVersion, lockSha256: ready.lockSha256 })
    if (!verified) throw new Error('Split runtime failed verification after publishing')
    // Only now drop the legacy generation (archive included).
    await rm(generation, { recursive: true, force: true })
    return { paths, freedFromLegacy: true }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Read-only plan: which legacy generations could be split, into which targets,
 * and what would conflict. Nothing is created, renamed or deleted here.
 */
export async function planSplitRuntime({ root, platform = process.platform, arch = process.arch }) {
  let entries = []
  try { entries = await readdir(root, { withFileTypes: true }) } catch { /* absent root */ }
  const legacies = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('node-')).map(entry => entry.name).sort()
  const mapped = []
  for (const name of legacies) {
    const generation = join(root, name)
    const ready = await readMarker(join(generation, 'ready.json'))
    const files = await readdir(generation).catch(() => [])
    const artifactDir = files.find(file => file.startsWith('node-') && !file.endsWith('.tar.gz')) ?? null
    const archiveName = files.find(file => file.endsWith('.tar.gz')) ?? null
    const entry = { legacy: name, generation, planable: false, reasons: [] }
    if (!ready) entry.reasons.push('missing ready.json')
    if (!artifactDir) entry.reasons.push('missing extracted Node directory')
    if (ready && (!ready.nodeVersion || !ready.reaVersion || !ready.lockSha256)) entry.reasons.push('ready.json is incomplete')
    if (ready?.platform && ready.platform !== platform) entry.reasons.push(`prepared for ${ready.platform}`)
    if (ready?.arch && ready.arch !== arch) entry.reasons.push(`prepared for ${ready.arch}`)
    if (ready && artifactDir) {
      const archiveSha256 = archiveName ? sha256(await readFile(join(generation, archiveName))) : ready.nodeArchiveSha256
      const paths = splitPaths(root, { platform, arch, nodeVersion: ready.nodeVersion, archiveSha256, reaVersion: ready.reaVersion, lockSha256: ready.lockSha256, artifact: { directory: artifactDir } })
      Object.assign(entry, {
        nodeId: paths.nodeId, engineId: paths.engineId,
        nodeDirectory: paths.nodeDirectory, engineDirectory: paths.engineDirectory,
        nodePath: paths.nodePath, reaEntry: paths.reaEntry,
        archiveSha256, archiveName, artifactDirectory: artifactDir,
      })
      const conflicts = []
      if (await maybeStat(paths.nodeDirectory)) conflicts.push('node target exists')
      if (await maybeStat(paths.engineDirectory)) conflicts.push('engine target exists')
      entry.conflicts = conflicts
      entry.planable = entry.reasons.length === 0 && conflicts.length === 0
    }
    mapped.push(entry)
  }
  // Generations installed from the same REA lock share one engine target; a real
  // migration must copy it once and then verify each generation against it.
  const seenEngine = new Map()
  const seenNode = new Map()
  for (const entry of mapped) {
    if (entry.engineDirectory) {
      if (seenEngine.has(entry.engineDirectory)) entry.sharedEngineWith = seenEngine.get(entry.engineDirectory)
      else seenEngine.set(entry.engineDirectory, entry.legacy)
    }
    if (entry.nodeDirectory) {
      if (seenNode.has(entry.nodeDirectory)) entry.sharedNodeWith = seenNode.get(entry.nodeDirectory)
      else seenNode.set(entry.nodeDirectory, entry.legacy)
    }
  }
  return { root, platform, arch, legacy: legacies.length, mapped, uniqueEngines: seenEngine.size, uniqueNodes: seenNode.size }
}

/**
 * Execute the split described by `planSplitRuntime`, without deleting the legacy
 * generations and without touching configuration. Engine trees are copied once
 * per unique target, then each generation is verified against its own Node.
 */
export async function applySplitRuntime({ root, platform = process.platform, arch = process.arch, run, log }) {
  const plan = await planSplitRuntime({ root, platform, arch })
  const created = { engines: [], nodes: [] }
  const skipped = []
  const failed = []
  const engineOwners = new Map()
  for (const entry of plan.mapped) {
    if (!entry.planable) { skipped.push({ legacy: entry.legacy, reasons: [...entry.reasons, ...(entry.conflicts ?? [])] }); continue }
    if (engineOwners.has(entry.engineDirectory)) { entry.sharedEngineWith = engineOwners.get(entry.engineDirectory); continue }
    engineOwners.set(entry.engineDirectory, entry.legacy)
  }
  try {
    // 1) Publish each unique engine exactly once.
    for (const [engineDirectory, owner] of engineOwners) {
      const entry = plan.mapped.find(item => item.legacy === owner)
      const existing = await readMarker(join(engineDirectory, 'ready.json'))
      if (existing) {
        const manifest = JSON.parse(await readFile(join(engineDirectory, 'node_modules', 'rea-agents', 'package.json'), 'utf8'))
        if (manifest.version !== existing.reaVersion) throw new Error(`Existing engine ${engineDirectory} does not match its marker`)
        created.engines.push({ directory: engineDirectory, reused: true })
        continue
      }
      const legacyReady = await readMarker(join(entry.generation, 'ready.json'))
      const staging = await mkdtemp(join(root, '.setup-split-'))
      try {
        const staged = join(staging, 'engine')
        await copyTree(join(entry.generation, 'engine'), staged)
        const manifest = JSON.parse(await readFile(join(staged, 'node_modules', 'rea-agents', 'package.json'), 'utf8'))
        if (manifest.name !== 'rea-agents' || manifest.version !== legacyReady.reaVersion) throw new Error('Engine package does not match the planned target')
        await writeFile(join(staged, 'ready.json'), JSON.stringify({
          formatVersion: 1,
          reaVersion: manifest.version,
          lockSha256: legacyReady.lockSha256,
          entrySha256: sha256(await readFile(join(staged, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'))),
          createdAt: new Date().toISOString(),
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
        await mkdir(join(root, 'engine'), { recursive: true })
        if (await maybeStat(engineDirectory)) throw new Error('Engine target appeared during migration; refusing to overwrite')
        await rename(staged, engineDirectory)
        created.engines.push({ directory: engineDirectory, reused: false })
        log?.(`Published engine ${engineDirectory}`)
      } finally { await rm(staging, { recursive: true, force: true }).catch(() => {}) }
    }
    // 2) Publish each Node tree, verified by running it.
    for (const entry of plan.mapped) {
      if (!entry.planable) continue
      if (await maybeStat(join(entry.nodeDirectory, 'ready.json'))) {
        created.nodes.push({ directory: entry.nodeDirectory, reused: true })
        continue
      }
      const staging = await mkdtemp(join(root, '.setup-split-'))
      try {
        const stagedNode = join(staging, 'node')
        await copyTree(join(entry.generation, entry.artifactDirectory), stagedNode)
        const ready = await readMarker(join(entry.generation, 'ready.json'))
        const stagedPath = { ...entry, nodePath: join(stagedNode, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node'])) }
        const version = await verifySplitNode(stagedPath, { run })
        if (version !== `v${ready.nodeVersion}`) throw new Error(`Staged Node reports ${version}, expected v${ready.nodeVersion}`)
        await writeFile(join(stagedNode, 'ready.json'), JSON.stringify({
          formatVersion: 1, nodeVersion: ready.nodeVersion, platform, arch,
          archiveSha256: entry.archiveSha256, createdAt: new Date().toISOString(),
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
        await mkdir(join(root, 'node'), { recursive: true })
        if (await maybeStat(entry.nodeDirectory)) throw new Error('Node target appeared during migration; refusing to overwrite')
        await rename(stagedNode, entry.nodeDirectory)
        created.nodes.push({ directory: entry.nodeDirectory, reused: false })
        log?.(`Published node ${entry.nodeDirectory}`)
      } catch (error) {
        failed.push({ legacy: entry.legacy, error: error.message })
      } finally { await rm(staging, { recursive: true, force: true }).catch(() => {}) }
    }
  } catch (error) {
    return { ok: false, error: error.message, created, skipped, failed, legacyPreserved: true, configUntouched: true }
  }
  // 3) Verify every legacy generation now resolves against the split layout.
  const verified = []
  const failedLegacy = new Set(failed.map(item => item.legacy))
  for (const entry of plan.mapped) {
    if (!entry.planable || failedLegacy.has(entry.legacy)) continue
    const ready = await readMarker(join(entry.generation, 'ready.json'))
    const state = await readSplitRuntime(
      { ...entry, nodeMarker: join(entry.nodeDirectory, 'ready.json'), engineMarker: join(entry.engineDirectory, 'ready.json') },
      { nodeVersion: ready.nodeVersion, reaVersion: ready.reaVersion, lockSha256: ready.lockSha256 },
    )
    if (state) verified.push(entry.legacy)
    else failed.push({ legacy: entry.legacy, error: 'split runtime did not verify' })
  }
  return {
    ok: failed.length === 0,
    created, skipped, failed, verified,
    legacyPreserved: true,
    configUntouched: true,
    uniqueEngines: engineOwners.size,
  }
}
