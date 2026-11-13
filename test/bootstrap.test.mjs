import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildMcpConfig } from '../lib/config.js'
import { nodeArtifact, runtimeRoot, runtimeLayout, npmEnvironment, downloadVerified, ensureRuntime, runProcess, ENGINE_LOCK_SHA256 } from '../lib/bootstrap.js'
import { cleanupStaging } from '../lib/bootstrap.js'

async function workspace(t) {
  const prefix=join(tmpdir(),'dsh-reakit-bootstrap-')
  const base=await mkdtemp(prefix)
  t.after(async()=>{assert.ok(resolve(base).startsWith(resolve(prefix)));await rm(base,{recursive:true,force:true})})
  return {base,root:join(base,'managed')}
}
const inspect=async settings=>({nodeVersion:'v24.22.1',reaVersion:'6.9.0',config:buildMcpConfig(settings)})
async function install(layout) {
  await mkdir(dirname(layout.nodePath),{recursive:true})
  await mkdir(dirname(layout.reaEntry),{recursive:true})
  await writeFile(layout.nodePath,'simulated pinned Node')
  await writeFile(layout.reaEntry,'simulated pinned REA')
}

test('fixed official downloads cover supported platform/architecture pairs',()=>{
  for(const platform of ['darwin','linux','win32']) for(const arch of ['arm64','x64']) {
    const artifact=nodeArtifact(platform,arch)
    assert.ok(artifact.url.startsWith('https://nodejs.org/dist/v24.22.1/'))
    assert.match(artifact.sha256,/^[a-f0-9]{64}$/)
    assert.equal(artifact.filename.endsWith('.zip'),platform==='win32')
  }
  assert.throws(()=>nodeArtifact('freebsd','arm64'),/does not support/)
  assert.throws(()=>nodeArtifact('linux','ia32'),/does not support/)
})

test('managed root is independent of workspace and enforces absolute paths',()=>{
  assert.equal(runtimeRoot({}, {DSH_HOME:'/data/dsh'},'/home/user'),'/data/dsh/dsh-reakit/runtime')
  assert.equal(runtimeRoot({}, {},'/home/user'),'/home/user/.dsh/dsh-reakit/runtime')
  assert.throws(()=>runtimeRoot({runtimeDir:'relative'}),/absolute/)
})

test('npm gets isolated config/environment without credentials or preloads',()=>{
  const env=npmEnvironment('/isolated/bin','/isolated/cache',{
    PATH:'/system/bin',HOME:'/home/test',DSH_TOKEN:'secret',NPM_CONFIG_REGISTRY:'https://evil.invalid',npm_config_ignore_scripts:'false',NODE_OPTIONS:'--require evil',NODE_PATH:'/evil',TAR_OPTIONS:'--checkpoint-action=exec=evil',LD_PRELOAD:'/evil.so',DYLD_INSERT_LIBRARIES:'/evil.dylib',HTTPS_PROXY:'http://127.0.0.1:3128',
  })
  assert.equal(env.npm_config_registry,'https://registry.npmjs.org/')
  assert.equal(env.npm_config_ignore_scripts,'true')
  assert.equal(env.npm_config_cache,'/isolated/cache')
  assert.equal(env.NODE_OPTIONS,'')
  for(const key of ['DSH_TOKEN','NPM_CONFIG_REGISTRY','TAR_OPTIONS','LD_PRELOAD','DYLD_INSERT_LIBRARIES']) assert.equal(env[key],undefined)
  assert.ok(env.PATH.startsWith('/isolated/bin'))
})

test('verified download rejects corruption before any extraction',async t=>{
  const {base}=await workspace(t)
  const bytes=Buffer.from('trusted archive fixture')
  const artifact={url:'https://nodejs.org/fixture',sha256:createHash('sha256').update(bytes).digest('hex')}
  await downloadVerified(artifact,join(base,'valid'),{fetchImpl:async(_url,options)=>{assert.equal(options.redirect,'error');return new Response(bytes)}})
  assert.deepEqual(await readFile(join(base,'valid')),bytes)
  await assert.rejects(downloadVerified(artifact,join(base,'corrupt'),{fetchImpl:async()=>new Response('modified bytes')}),/SHA-256 mismatch/)
  await assert.rejects(downloadVerified(artifact,join(base,'oversize'),{fetchImpl:async()=>new Response('x',{headers:{'content-length':String(129*1024*1024)}})}),/128 MiB/)
  await assert.rejects(downloadVerified(artifact,join(base,'http-failure'),{fetchImpl:async()=>new Response('no',{status:503})}),/HTTP 503/)
})

test('first activation publishes a complete runtime; second start reuses it offline',async t=>{
  const {root}=await workspace(t)
  let installs=0
  const settings={runtimeDir:root}
  const first=await ensureRuntime(settings,{inspect,install:async layout=>{installs++;await install(layout)}})
  assert.equal(first.nodeVersion,'v24.22.1')
  const layout=runtimeLayout(root)
  const nodeMarker=JSON.parse(await readFile(layout.nodeMarker,'utf8'))
  const engineMarker=JSON.parse(await readFile(layout.engineMarker,'utf8'))
  assert.equal(engineMarker.lockSha256,ENGINE_LOCK_SHA256)
  assert.equal(engineMarker.formatVersion,1)
  assert.equal(nodeMarker.formatVersion,1)
  assert.equal(nodeMarker.nodeVersion,'24.22.1')
  await assert.doesNotReject(access(layout.nodePath), 'node part published')
  await assert.doesNotReject(access(layout.reaEntry), 'engine part published')
  const second=await ensureRuntime({...settings,autoSetup:false},{inspect,install:()=>assert.fail('offline start must never install')})
  assert.equal(second.config.command,first.config.command)
  assert.equal(installs,1)
  await assert.rejects(access(join(root,'.setup.lock')),{code:'ENOENT'})
})

test('offline missing runtime never creates folders or installs',async t=>{
  const {root}=await workspace(t)
  await assert.rejects(ensureRuntime({runtimeDir:root,autoSetup:false},{inspect,install:()=>assert.fail('must not run')}),/autoSetup=false/)
  await assert.rejects(access(root),{code:'ENOENT'})
})

test('failed setup never publishes and may be retried without deleting old work',async t=>{
  const {root}=await workspace(t)
  await assert.rejects(ensureRuntime({runtimeDir:root},{inspect,install:async()=>{throw new Error('network unavailable')}}),/network unavailable/)
  await assert.rejects(access(runtimeLayout(root).nodeDirectory),{code:'ENOENT'})
  await assert.rejects(access(join(root,'.setup.lock')),{code:'ENOENT'})
  assert.equal((await ensureRuntime({runtimeDir:root},{inspect,install})).reaVersion,'6.9.0')
})

test('concurrent setup has exactly one installer and independently rechecks ready state',async t=>{
  const {root}=await workspace(t)
  let installs=0
  const options={inspect,install:async layout=>{installs++;await delay(50);await install(layout)}}
  const [a,b]=await Promise.all([ensureRuntime({runtimeDir:root},options),ensureRuntime({runtimeDir:root},options)])
  assert.equal(installs,1)
  assert.equal(a.config.command,b.config.command)
})

test('abort releases own lock and leaves no published generation',async t=>{
  const {root}=await workspace(t)
  const controller=new AbortController()
  await assert.rejects(ensureRuntime({runtimeDir:root},{inspect,signal:controller.signal,install:async(_layout,{signal})=>{controller.abort(new Error('unloaded'));signal.throwIfAborted()}}),/unloaded/)
  await assert.rejects(access(runtimeLayout(root).nodeDirectory),{code:'ENOENT'})
  await assert.rejects(access(join(root,'.setup.lock')),{code:'ENOENT'})
})

test('modified ready runtime and symlink root fail closed without repair',async t=>{
  const {base,root}=await workspace(t)
  await ensureRuntime({runtimeDir:root},{inspect,install})
  await writeFile(runtimeLayout(root).nodePath,'tampered')
  await assert.rejects(ensureRuntime({runtimeDir:root},{inspect,install:()=>assert.fail('must preserve corrupted directory')}),/digest changed/)
  const alias=join(base,'alias')
  await symlink(root,alias,'dir')
  await assert.rejects(ensureRuntime({runtimeDir:alias},{inspect,install}),/not a symlink/)
})

test('subprocess errors and cancellation settle only after process cleanup',async()=>{
  await assert.rejects(runProcess(process.execPath,['-e','process.stderr.write("expected failure");process.exit(3)']),/expected failure/)
  const controller=new AbortController()
  const pending=runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal})
  setTimeout(()=>controller.abort(new Error('cancel owned process')),100).unref()
  await assert.rejects(pending,/cancel owned process/)
})

test('abandoned staging directories are removed after the grace period', async () => {
  const root = await (await import('node:fs/promises')).mkdtemp(join((await import('node:os')).tmpdir(), 'reakit-stage-'))
  const { mkdir, writeFile, utimes, readdir, rm } = await import('node:fs/promises')
  await mkdir(join(root, '.setup-old'), { recursive: true })
  await writeFile(join(root, '.setup-old', 'blob'), 'x')
  await mkdir(join(root, '.setup-fresh'), { recursive: true })
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  await utimes(join(root, '.setup-old'), old, old)
  const removed = await cleanupStaging(root)
  assert.deepEqual(removed, ['.setup-old'])
  assert.deepEqual((await readdir(root)).sort(), ['.setup-fresh'])
  await rm(root, { recursive: true, force: true })
})

test('removing only the Node part is repaired by reusing the installed engine',async t=>{
  const {root}=await workspace(t)
  const settings={runtimeDir:root}
  await ensureRuntime(settings,{inspect,install})
  const layout=runtimeLayout(root)
  const engineMarkerBefore=await readFile(layout.engineMarker,'utf8')
  await rm(layout.nodeDirectory,{recursive:true,force:true})
  let installs=0
  const restored=await ensureRuntime(settings,{inspect,install:async(staged)=>{installs++;assert.equal(staged.reuseEngine,true,'engine is reused');await mkdir(dirname(staged.nodePath),{recursive:true});await writeFile(staged.nodePath,'simulated pinned Node')}})
  assert.equal(installs,1)
  assert.equal(restored.reaVersion,'6.9.0')
  assert.equal(await readFile(layout.engineMarker,'utf8'),engineMarkerBefore,'engine marker is untouched')
  await assert.doesNotReject(access(layout.nodePath))
  await assert.doesNotReject(access(layout.reaEntry))
})

test('a configured registry is validated and used for package installs', async () => {
  const { resolveRegistry } = await import('../lib/bootstrap.js')
  assert.equal(resolveRegistry(''), 'https://registry.npmjs.org/')
  assert.equal(resolveRegistry(undefined), 'https://registry.npmjs.org/')
  assert.equal(resolveRegistry('https://registry.npmmirror.com'), 'https://registry.npmmirror.com/')
  for (const bad of ['http://mirror.example.com', 'https://user:pass@mirror.example.com', 'https://mirror.example.com/?token=1', 'not a url']) {
    assert.throws(() => resolveRegistry(bad), /npmRegistry/, bad)
  }
  const env = npmEnvironment('/isolated/bin', '/isolated/cache', { PATH: '/system/bin', HOME: '/home/test', NPM_CONFIG_REGISTRY: 'https://evil.invalid' }, 'https://mirror.example.com/')
  assert.equal(env.npm_config_registry, 'https://mirror.example.com/')
  assert.equal(env.NPM_CONFIG_REGISTRY, undefined)
})

test('the configured registry reaches the installer', async t => {
  const { root } = await workspace(t)
  let seen
  await ensureRuntime({ runtimeDir: root, npmRegistry: 'https://mirror.example.com' }, {
    inspect,
    install: async (layout, options) => { seen = options.registry; await install(layout) },
  })
  assert.equal(seen, 'https://mirror.example.com/')
})

test('an invalid registry fails before any download', async t => {
  const { root } = await workspace(t)
  let ran = false
  await assert.rejects(
    ensureRuntime({ runtimeDir: root, npmRegistry: 'http://insecure.example.com' }, { inspect, install: async () => { ran = true } }),
    /npmRegistry must use https/,
  )
  assert.equal(ran, false, 'nothing was installed')
  await assert.rejects(access(join(root, 'node')), { code: 'ENOENT' })
})

test('the configured Node mirror reaches the installer', async t => {
  const { root } = await workspace(t)
  let seen
  await ensureRuntime({ runtimeDir: root, nodeMirror: 'https://mirror.example.com/nodejs' }, {
    inspect,
    install: async (layout, options) => { seen = options.nodeMirror; await install(layout) },
  })
  assert.equal(seen, 'https://mirror.example.com/nodejs')
})

test('an invalid Node mirror fails before any download', async t => {
  const { root } = await workspace(t)
  let ran = false
  await assert.rejects(
    ensureRuntime({ runtimeDir: root, nodeMirror: 'http://insecure.example.com' }, { inspect, install: async () => { ran = true } }),
    /nodeMirror must use https/,
  )
  assert.equal(ran, false)
})

test('an already prepared managed runtime is recognised without downloading', async () => {
  const { hasManagedRuntime } = await import('../lib/index.js')
  const { runtimeLayout } = await import('../lib/bootstrap.js')
  const root = await mkdtemp(join(tmpdir(), 'reakit-managed-'))
  const layout = runtimeLayout(join(root, 'runtime'))
  for (const marker of [layout.nodeMarker, layout.engineMarker]) {
    await mkdir(dirname(marker), { recursive: true })
    await writeFile(marker, JSON.stringify({ formatVersion: 1 }))
  }
  assert.equal(await hasManagedRuntime({ runtimeDir: join(root, 'runtime') }), true)
  // A half-removed runtime (Node deleted) is not usable and must not count.
  await rm(layout.nodeMarker)
  assert.equal(await hasManagedRuntime({ runtimeDir: join(root, 'runtime') }), false)
  await rm(root, { recursive: true, force: true })
})

test('an engine-only install reuses an existing engine and needs npm from that Node', async () => {
  const { installEngineWithNode, npmCliFor } = await import('../lib/bootstrap.js')
  const root = await mkdtemp(join(tmpdir(), 'reakit-engine-only-'))
  const engineDirectory = join(root, 'engine', 'rea-test')
  await mkdir(engineDirectory, { recursive: true })
  await writeFile(join(engineDirectory, 'ready.json'), JSON.stringify({ formatVersion: 1 }))
  // A prepared engine is reused without touching npm.
  const reused = await installEngineWithNode({ root, engineDirectory, nodePath: '/nonexistent/node' })
  assert.equal(reused.reused, true)
  // Without a prepared engine the chosen Node must ship npm.
  await rm(join(engineDirectory, 'ready.json'))
  await assert.rejects(
    installEngineWithNode({ root, engineDirectory, nodePath: '/nonexistent/node' }),
    /does not ship npm/,
  )
  assert.equal(npmCliFor('/home/user/.nvm/versions/node/v24/bin/node'), '/home/user/.nvm/versions/node/v24/lib/node_modules/npm/bin/npm-cli.js')
  await rm(root, { recursive: true, force: true })
})

test('a prepared runtime is rediscovered when the configuration forgot its paths', async () => {
  const { discoverInstalledRuntime } = await import('../lib/index.js')
  const root = await mkdtemp(join(tmpdir(), 'reakit-rediscover-'))
  const nodeId = 'darwin-arm64-26.13.0-abc123456789'
  const engineId = 'rea6.9.0-def123456789'
  await mkdir(join(root, 'node', nodeId, 'bin'), { recursive: true })
  await mkdir(join(root, 'engine', engineId, 'node_modules', 'rea-agents', 'scripts'), { recursive: true })
  await writeFile(join(root, 'node', nodeId, 'ready.json'), JSON.stringify({ formatVersion: 1, nodeVersion: '26.13.0' }))
  await writeFile(join(root, 'engine', engineId, 'ready.json'), JSON.stringify({ formatVersion: 1, reaVersion: '6.9.0', nodeRange: '>=26.12.1' }))
  const found = await discoverInstalledRuntime({ runtimeDir: root })
  assert.equal(found.config.managedReaVersion, '6.9.0')
  assert.equal(found.config.managedNodeRange, '>=26.12.1')
  assert.ok(found.nodePath.includes(nodeId))
  assert.ok(found.reaEntry.includes(engineId))
  // A Node that does not satisfy the engine range is not offered.
  await writeFile(join(root, 'engine', engineId, 'ready.json'), JSON.stringify({ formatVersion: 1, reaVersion: '6.9.0', nodeRange: '>=99' }))
  assert.equal(await discoverInstalledRuntime({ runtimeDir: root }), null)
  await rm(root, { recursive: true, force: true })
})

test('the manifest declares no DSH version constraint', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  // DSH only refuses a plugin whose manifest declares engines.dsh or an
  // @deepseek-ai/dsh-* peer range; declaring neither imposes no constraint.
  assert.equal(manifest.engines && manifest.engines.dsh, undefined)
  const peers = Object.keys(manifest.peerDependencies || {})
  assert.deepEqual(peers.filter(name => name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/dsh-')), [])
  // The Node requirement stays, because that one is about npm, not DSH.
  assert.equal(manifest.engines.node, '>=22')
})
