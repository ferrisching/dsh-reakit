import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, stat, rm, access, writeFile as writeText } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { COMPONENTS, ENV_KEYS, JADX_RELEASE, aiPrompt, createComponentManager, validateSetting } from '../lib/components.js'
import { COMPONENTS_TYPERT, ComponentsController, componentConfiguration, installReviewedJar, registerComponents } from '../lib/components-host.js'

const missing = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
const file = { isFile: () => true, isDirectory: () => false, size: 2 }
const directory = { isFile: () => false, isDirectory: () => true, size: 2 }
function manager(options = {}) {
  return createComponentManager({ environment: { PATH: '/mock/bin' }, platform: 'darwin', access: missing, stat: missing, realpath: async path => path, ...options })
}
function brewFixture(overrides = {}) {
  const calls = []
  const info = { formulae: [{ name: 'wabt', versions: { stable: '1.0.42' }, installed: [], dependencies: ['example-shared-dependency'], urls: { stable: { url: 'https://github.com/WebAssembly/wabt/archive/refs/tags/1.0.42.tar.gz' } } }], casks: [] }
  let installed = 'example-shared-dependency 1.0\n'
  let dependencyRevision = 0
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0] === '--version') return { stdout: 'Homebrew 5.0\n', stderr: '' }
    if (args[0] === 'deps') return { stdout: 'example-shared-dependency\n', stderr: '' }
    if (args[0] === 'info') return { stdout: JSON.stringify(args[2] === 'wabt' ? info : { formulae: args.slice(2).map(name => ({ name, versions: { stable: '2.0' }, revision: dependencyRevision, dependencies: [] })), casks: [] }), stderr: '' }
    if (args[0] === 'list') return { stdout: installed, stderr: '' }
    if (args.includes('--dry-run')) return { stdout: 'Would upgrade example-shared-dependency 1.0 -> 2.0\nWould install wabt 1.0.42\n', stderr: '' }
    if (args[0] === 'install') return { stdout: 'installed', stderr: '' }
    throw new Error('unexpected command')
  }
  const instance = manager({ access: async path => { if (path !== '/mock/bin/brew') throw new Error('missing') }, run, ...overrides })
  return { calls, info, instance, setInstalled: value => { installed = value }, changeDependencyRevision: () => { dependencyRevision++ } }
}

test('catalog retains all major capability families and commercial boundaries', () => {
  for (const id of ['builtin', 'ghidra', 'java', 'jadx', 'wabt', 'frida', 'pty', 'hopper', 'ida', 'jeb', 'adb', 'apktool', 'browser', 'pwntools', 'gdb', 'rizin', 'objdump', 'tshark', 'sigrok', 'binwalk', 'unblob', 'mitmproxy', 'apple']) assert.ok(COMPONENTS.some(row => row.id === id), id)
  assert.ok(COMPONENTS.filter(row => row.license).every(row => !row.brew && !row.install))
  assert.ok(ENV_KEYS.includes('GHIDRA_INSTALL_DIR'))
})

test('legacy component prompts also configure only the installed dsh-reakit plugin', () => {
  for (const component of COMPONENTS) {
    const value = aiPrompt(component)
    assert.match(value, /^You are configuring .* for the dsh-reakit plugin already installed in DeepSeek Harness/)
    assert.ok(value.includes(component.name))
    for (const file of ['README.md', 'package.json', 'lib/config.js', 'lib/bootstrap.js', 'assets/engine/dependencies.lock.json']) assert.ok(value.includes(file), `${component.id}: ${file}`)
    for (const boundary of [/not a standalone REA installation from the upstream repository tutorial/, /ask before guessing paths or APIs/, /Reuse the plugin's verified managed Node \/ REA and locked dependencies/, /Do not clone the REA repository, install rea-agents globally/, /add an independent REA service or another MCP client registration/, /or edit the plugin lockfile/, /use the DSH ConfigEditor to merge only the required env keys/, /keep the existing enabled, autoSetup, nodePath, reaEntry, runtimeDir, serverName/, /Never enable REA while it is disabled/, /confirm that unsaved evidence was exported/, /Verify the capability minimally through the MCP tools this plugin actually registered in DSH/, /never substituting a standalone REA CLI or doctor success for plugin readiness/]) assert.match(value, boundary, component.id)
  }
})

test('description is read-only and missing runtime never uses a project runtime', async () => {
  const instance = manager({ run: () => assert.fail('no executable should run') })
  const view = await instance.describe()
  assert.equal(view.runtime.phase, 'idle')
  assert.equal(view.components.find(row => row.id === 'frida').status, 'manual')
  assert.equal(view.components.find(row => row.id === 'hopper').status, 'license')
  assert.match(view.components.find(row => row.id === 'tshark').detail, /requires Linux/)
  assert.match(view.components.find(row => row.id === 'frida').aiPrompt, /do not upgrade globally/i)
})

test('native binding detection uses the selected REA runtime and preserves failures', async () => {
  const calls = []
  const view = await manager({ getRuntimeState: () => ({ phase: 'ready', nodePath: '/managed/node', reaEntry: '/managed/rea/scripts/rea.mjs' }), run: async (command, args) => {
    calls.push([command, args])
    if (args[1].includes('"frida"')) throw new Error('frida_binding.node missing')
    return { stdout: 'binding-loaded', stderr: '' }
  } }).describe()
  assert.equal(view.components.find(row => row.id === 'frida').status, 'manual')
  assert.match(view.components.find(row => row.id === 'frida').detail, /frida_binding.node missing/)
  assert.equal(view.components.find(row => row.id === 'pty').status, 'ready')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(([command, args]) => command === '/managed/node' && args[2] === '/managed/rea/scripts/rea.mjs'))
})

test('Ghidra cannot be ready without a verified full JDK', async () => {
  const view = await manager({ getSettings: () => ({ env: { GHIDRA_INSTALL_DIR: '/ghidra' } }), stat: async path => { if (path === '/ghidra/support/analyzeHeadless') return file; throw new Error('missing') } }).describe()
  const row = view.components.find(item => item.id === 'ghidra')
  assert.equal(row.status, 'manual')
  assert.match(row.detail, /full JDK is not ready/)
})

test('dependency metadata revision drift invalidates a same-text dry-run plan', async () => {
  const fixture = brewFixture()
  const plan = await fixture.instance.previewInstall('wabt')
  assert.deepEqual(plan.dependencies, [{ name: 'example-shared-dependency', version: '2.0', revision: 0 }])
  fixture.changeDependencyRevision()
  await assert.rejects(fixture.instance.install(plan.token, true), /changed/)
  assert.ok(!fixture.calls.some(call => call.args[0] === 'install' && !call.args.includes('--dry-run')))
})

test('JDK detection requires the compiler module and returns exact discovered home', async () => {
  const instance = manager({ access: async path => { if (path !== '/mock/bin/java') throw new Error('missing') }, stat: async () => file, run: async () => ({ stdout: 'java.base@21.0.6\njdk.compiler@21.0.6\n', stderr: '' }) })
  const row = (await instance.describe()).components.find(row => row.id === 'java')
  assert.equal(row.status, 'ready')
  assert.deepEqual(row.suggestions, { JAVA_HOME: '/mock' })
})

test('WABT readiness requires all three exact version probes', async () => {
  const calls = []
  const instance = manager({ getSettings: () => ({ env: { REA_WABT_BIN_DIRECTORY: '/wabt/bin' } }), run: async (command) => { calls.push(command); return { stdout: '1.0.42\n', stderr: '' } } })
  const row = (await instance.describe()).components.find(row => row.id === 'wabt')
  assert.equal(row.status, 'ready')
  assert.deepEqual(calls, ['/wabt/bin/wasm-validate', '/wabt/bin/wasm-objdump', '/wabt/bin/wasm2wat'])
  const bad = manager({ getSettings: () => ({ env: { REA_WABT_BIN_DIRECTORY: '/wabt/bin' } }), run: async () => ({ stdout: '1.0.41', stderr: '' }) })
  assert.equal((await bad.describe()).components.find(row => row.id === 'wabt').status, 'manual')
})

test('preview shows shared upgrades but never installs, confirmation is mandatory', async () => {
  const fixture = brewFixture()
  const plan = await fixture.instance.previewInstall('wabt')
  assert.match(plan.preview, /Would upgrade example-shared-dependency/)
  assert.ok(!fixture.calls.some(call => call.args[0] === 'install' && !call.args.includes('--dry-run')))
  await assert.rejects(fixture.instance.install(plan.token, false), /explicitly confirm/)
  await fixture.instance.install(plan.token, true)
  const actual = fixture.calls.filter(call => call.args[0] === 'install' && !call.args.includes('--dry-run'))
  assert.equal(actual.length, 1)
  assert.deepEqual(actual[0].args, ['install', '--formula', '--force-bottle', 'wabt'])
  assert.equal(actual[0].options.env.HOMEBREW_NO_AUTO_UPDATE, '1')
  assert.equal(actual[0].options.env.HOMEBREW_NO_INSTALL_CLEANUP, '1')
  await assert.rejects(fixture.instance.install(plan.token, true), /expired/)
})

test('changed installed shared dependencies invalidate the plan before mutation', async () => {
  const fixture = brewFixture()
  const plan = await fixture.instance.previewInstall('wabt')
  fixture.setInstalled('example-shared-dependency 3.0\n')
  await assert.rejects(fixture.instance.install(plan.token, true), /changed/)
  assert.ok(!fixture.calls.some(call => call.args[0] === 'install' && !call.args.includes('--dry-run')))
  assert.equal((await fixture.instance.describe()).lastOperation.phase, 'error')
})

test('changed metadata, incompatible WABT, installed targets and commercial installs fail closed', async () => {
  const fixture = brewFixture()
  const plan = await fixture.instance.previewInstall('wabt')
  fixture.info.formulae[0].dependencies.push('surprise-dependency')
  await assert.rejects(fixture.instance.install(plan.token, true), /changed/)
  fixture.info.formulae[0].versions.stable = '1.0.43'
  await assert.rejects(fixture.instance.previewInstall('wabt'), /incompatible version/)
  fixture.info.formulae[0].versions.stable = '1.0.42'; fixture.info.formulae[0].installed = [{ version: '1.0.42' }]
  await assert.rejects(fixture.instance.previewInstall('wabt'), /never upgrades or reinstalls implicitly/)
  for (const id of ['hopper', 'ida', 'jeb', 'evil; rm -rf /']) await assert.rejects(fixture.instance.previewInstall(id), /cannot be auto-installed/)
})

test('expired previews cannot install and default JAR preview performs no network', async () => {
  let now = 0, installs = 0
  const instance = manager({ now: () => now, installJar: async () => { installs++ } })
  const plan = await instance.previewInstall('jadx')
  assert.equal(plan.source, JADX_RELEASE.url)
  assert.equal(plan.sha256, JADX_RELEASE.sha256)
  assert.equal(installs, 0)
  now = 300001
  await assert.rejects(instance.install(plan.token, true), /expired/)
  assert.equal(installs, 0)
})

test('failed installation never reports ready or success', async () => {
  const instance = manager({ installJar: async () => { throw new Error('offline') } })
  const plan = await instance.previewInstall('jadx')
  await assert.rejects(instance.install(plan.token, true), /offline/)
  assert.deepEqual((await instance.describe()).lastOperation, { operation: 1, phase: 'error', message: 'offline' })
})

test('only documented absolute paths or credential-free loopback endpoints can be configured', async () => {
  assert.equal(validateSetting('REA_JEB_MCP_URL', 'http://127.0.0.1:8425/mcp'), 'http://127.0.0.1:8425/mcp')
  for (const value of ['https://example.com/mcp', 'http://user:pass@127.0.0.1/mcp', 'file:///tmp/a', 'http://127.0.0.1/mcp?token=secret']) assert.throws(() => validateSetting('REA_JEB_MCP_URL', value))
  assert.throws(() => validateSetting('NODE_OPTIONS', '/tmp/a'))
  assert.throws(() => validateSetting('GHIDRA_INSTALL_DIR', 'relative/path'))
  assert.throws(() => validateSetting('JAVA_HOME', '/a\u0000b'))
  const writes = []
  const instance = manager({ stat: async () => directory, configure: async patch => writes.push(patch) })
  await instance.configure('ghidra', { GHIDRA_INSTALL_DIR: '/engines/ghidra' })
  assert.deepEqual(writes, [{ GHIDRA_INSTALL_DIR: '/engines/ghidra' }])
  await assert.rejects(instance.configure('ghidra', { REA_BROWSER_EXECUTABLE: '/browser' }), /Only the configuration keys/)
  assert.equal(writes.length, 1)
})

test('official ConfigEditor merges inherited and current values and touches only the owned entry', async () => {
  const ctx = { fiber: {} }
  const entry = { fiber: { ctx: { fiber: ctx.fiber } }, options: { id: 'custom-rea', config: { enabled: true, env: { REA_ADB_PATH: '/old/adb' }, cwd: '/project' } } }
  const inherited = { serverName: 'rea', toolCallTimeoutMs: 450000, env: { JAVA_HOME: '/jdk', REA_UNBLOB_COMMAND: '/unblob' } }
  const editor = { entries: () => [entry], configuration: () => [{ entry, inherited }], edit: async (target, change) => { assert.equal(target, entry); entry.options.config = change(entry.options.config, inherited) } }
  ctx.get = name => name === 'configEditor' ? editor : undefined
  const configuration = componentConfiguration(ctx)
  assert.equal(configuration.entryId(), 'custom-rea')
  await configuration.env({ GHIDRA_INSTALL_DIR: '/ghidra' })
  assert.equal(entry.options.config.cwd, '/project')
  assert.equal(entry.options.config.toolCallTimeoutMs, 450000)
  assert.deepEqual(entry.options.config.env, { JAVA_HOME: '/jdk', REA_UNBLOB_COMMAND: '/unblob', REA_ADB_PATH: '/old/adb', GHIDRA_INSTALL_DIR: '/ghidra' })
  const before = structuredClone(entry.options.config)
  await configuration.enabled(false)
  assert.deepEqual(entry.options.config, { ...before, enabled: false })
  assert.equal(configuration.read().enabled, false)
  assert.equal(configuration.readStrict().toolCallTimeoutMs, 450000)
  const beforeRuntime = structuredClone(entry.options.config)
  await configuration.runtimePaths({ nodePath: '/managed/node', reaEntry: '/managed/rea/scripts/rea.mjs', managedReaVersion: '6.9.0', managedNodeRange: '>=24.22.1' }, beforeRuntime)
  assert.equal(entry.options.config.managedReaVersion, '6.9.0')
  assert.equal(entry.options.config.cwd, beforeRuntime.cwd)
  assert.deepEqual(entry.options.config.env, beforeRuntime.env)
  const accepted = structuredClone(entry.options.config)
  await assert.rejects(configuration.runtimePaths({ nodePath: '', reaEntry: '', managedReaVersion: '', managedNodeRange: '' }, { ...accepted, nodePath: '/other-window' }), /changed in another window/)
  assert.deepEqual(entry.options.config, accepted)
  await assert.rejects(componentConfiguration({ fiber: {}, get: () => editor }).enabled('no'), /must be a boolean/)
})

test('unknown/ambiguous profile ownership never writes another REA instance', async () => {
  let writes = 0
  const editor = { entries: () => [{ fiber: { ctx: { fiber: {} } }, options: { name: 'dsh-reakit' } }], edit: () => { writes++ } }
  const configuration = componentConfiguration({ fiber: {}, get: () => editor })
  assert.equal(configuration.writable(), false)
  await assert.rejects(configuration.enabled(false), /Cannot uniquely locate/)
  assert.equal(writes, 0)
})

test('JAR hash mismatch cleans only its temporary file and never publishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reakit-components-'))
  const destination = join(root, 'jadx-headless-mcp-0.7.1-all.jar')
  try {
    await assert.rejects(installReviewedJar({ source: JADX_RELEASE.url, sha256: JADX_RELEASE.sha256, destination }, undefined, { fetch: async () => new Response('not the reviewed JAR') }), /SHA-256 mismatch/)
    await assert.rejects(stat(destination), /ENOENT/)
    await assert.rejects(installReviewedJar({ source: JADX_RELEASE.url, sha256: JADX_RELEASE.sha256, destination }, undefined, { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/payload' } }) }), /allowed HTTPS GitHub release hosts/)
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-reakit-components-')))
    await rm(root, { recursive: true })
  }
})

test('Remote descriptors and controller keep owner authentication and retry diagnostics', async () => {
  assert.deepEqual(COMPONENTS_TYPERT.invocations.map(item => item.method), ['describe', 'status', 'retrySetup', 'setEnabled', 'detectExisting', 'detectNodes', 'nodeEnvironment', 'setNodeEnvironment', 'adoptExisting', 'installEngineWithHostNode', 'removeManagedNode', 'installManagedNode', 'useManagedRuntime', 'preferManaged', 'managedEnvironment', 'keepManagedEnvironment', 'removeManagedEnvironment', 'migrateRuntime', 'applyRuntimeSplit', 'checkRuntimeUpdates', 'prepareRuntimeSwitch', 'rollbackRuntime', 'previewInstall', 'install', 'configure'])
  assert.ok(COMPONENTS_TYPERT.invocations.every(item => item.service === 'reaComponentsController' && item.namespace === 'reaComponents'))
  const ctx = new Context()
  await ctx.plugin(function controller(inner) { new ComponentsController(inner, { manager: { describe: async () => ({ runtime: { phase: 'error', message: 'setup failed' } }) }, configuration: { writable: () => true, read: () => ({ enabled: true }) }, retrySetup: async () => { throw new Error('download failed') } }) })
  try {
    await assert.rejects(ctx.reaComponentsController.describe(), /restricted to the authenticated host owner/)
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const view = await owner.reaComponentsController.describe()
    assert.equal(view.runtime.phase, 'error')
    await assert.rejects(owner.reaComponentsController.retrySetup(), /download failed/)
  } finally { await ctx.fiber.dispose() }
})

test('adopting an existing REA writes the manual pair and can return to the managed runtime', async () => {
  const writes = []
  const configuration = {
    read: () => ({ enabled: true, nodePath: '/managed/node', reaEntry: '/managed/rea.mjs', managedReaVersion: '6.8.0', managedNodeRange: '^24.0.0' }),
    runtimePaths: async (next, expected) => { writes.push({ next, expected }); return { saved: true } },
    writable: () => true,
    entryId: () => 'rea',
  }
  const ctx = new Context()
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: { describe: async () => ({ components: [] }) },
      configuration,
      retrySetup: async () => {},
      getRuntimeState: () => ({ phase: 'ready', nodePath: '/managed/node', reaEntry: '/managed/rea.mjs' }),
      versions: { status: () => ({ phase: 'idle' }) },
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const adopted = await owner.reaComponentsController.useManagedRuntime()
    assert.equal(adopted.saved, true)
    assert.deepEqual(writes.at(-1).next, { nodePath: '', reaEntry: '', managedReaVersion: '', managedNodeRange: '', keepManagedRuntime: false })
    assert.equal(writes.at(-1).expected.nodePath, '/managed/node', 'compares the current pair before writing')
    await assert.rejects(ctx.reaComponentsController.useManagedRuntime(), /restricted to the authenticated host owner/)
  } finally { await ctx.fiber.dispose() }
})

test('an existing-REA adoption is refused for a path that is not a package entry', async () => {
  const configuration = {
    read: () => ({ enabled: true, nodePath: '', reaEntry: '', managedReaVersion: '', managedNodeRange: '' }),
    runtimePaths: async () => { throw new Error('must not write') },
    writable: () => true,
    entryId: () => 'rea',
  }
  const ctx = new Context()
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, { manager: {}, configuration, retrySetup: async () => {}, getRuntimeState: () => ({ phase: 'ready' }), versions: { status: () => ({}) } })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    await assert.rejects(owner.reaComponentsController.adoptExisting('/tmp/definitely-not-rea/package.json'), /scripts\/rea\.mjs|does not exist/)
  } finally { await ctx.fiber.dispose() }
})

test('a managed runtime is never reported as an adopted installation', async () => {
  let config = { enabled: true, nodePath: '/managed/node', reaEntry: '/managed/rea.mjs', managedReaVersion: '6.8.0', managedNodeRange: '^24.0.0' }
  const ctx = new Context()
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, { manager: {}, configuration: { read: () => config, writable: () => true }, retrySetup: async () => {}, getRuntimeState: () => ({ phase: 'ready' }), versions: { status: () => ({}) } })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const managed = await owner.reaComponentsController.detectExisting()
    assert.equal(managed.current.manual, false, 'derived managed paths are not an adoption')
    config = { enabled: true, nodePath: '/custom/node', reaEntry: '/custom/node_modules/rea-agents/scripts/rea.mjs', managedReaVersion: '', managedNodeRange: '' }
    const adopted = await owner.reaComponentsController.detectExisting()
    assert.equal(adopted.current.manual, true)
  } finally { await ctx.fiber.dispose() }
})

test('adopting a real package writes the chosen Node and entry pair', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-adopt-'))
  const dir = join(base, 'rea-agents')
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeText(join(dir, 'scripts', 'rea.mjs'), 'export {}\n')
  await writeText(join(dir, 'package.json'), JSON.stringify({ name: 'rea-agents', version: '6.9.0', engines: { node: '>=20.0.0' } }))
  const entry = join(dir, 'scripts', 'rea.mjs')
  const writes = []
  const configuration = {
    read: () => ({ enabled: true, nodePath: '', reaEntry: '', managedReaVersion: '', managedNodeRange: '' }),
    runtimePaths: async (next, expected) => { writes.push({ next, expected }); return { saved: true } },
    writable: () => true,
  }
  const ctx = new Context()
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: {}, configuration, retrySetup: async () => {},
      getRuntimeState: () => ({ phase: 'ready', nodePath: process.execPath, nodeVersion: 'v26.13.0' }),
      versions: { status: () => ({}) },
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const result = await owner.reaComponentsController.adoptExisting(entry, process.execPath)
    assert.equal(result.saved, true)
    assert.equal(result.reaVersion, '6.9.0')
    const { realpath } = await import('node:fs/promises')
    assert.deepEqual(writes.at(-1).next, { nodePath: process.execPath, reaEntry: await realpath(entry), managedReaVersion: '', managedNodeRange: '', keepManagedRuntime: false })
  } finally { await ctx.fiber.dispose() }
})

test('the managed environment is measured and removed only when unused', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'reakit-env-'))
  const settings = { enabled: true, nodePath: '', reaEntry: '', runtimeDir }
  await mkdir(join(runtimeDir, 'node', 'darwin-arm64-26.13.0-abc', 'bin'), { recursive: true })
  await writeText(join(runtimeDir, 'node', 'darwin-arm64-26.13.0-abc', 'bin', 'node'), Buffer.alloc(2048))
  await mkdir(join(runtimeDir, 'engine', 'rea6.8.0-abc', 'node_modules', 'rea-agents', 'scripts'), { recursive: true })
  await writeText(join(runtimeDir, 'engine', 'rea6.8.0-abc', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'), 'export {}\n')
  await mkdir(join(runtimeDir, 'node-24.22.1-rea-6.8.0-darwin-arm64-abc'), { recursive: true })
  await mkdir(join(runtimeDir, 'npm-cache'), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: {}, retrySetup: async () => {}, getRuntimeState: () => ({ phase: 'ready' }),
      versions: { status: () => ({}) },
      configuration: { read: () => settings, writable: () => true, entryId: () => 'rea' },
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const measured = await owner.reaComponentsController.managedEnvironment()
    assert.ok(measured.nodeBytes >= 2048, 'counts the Node tree')
    assert.ok(measured.engineBytes > 0, 'counts the engine tree')
    assert.equal(measured.legacy.length, 1, 'combined generations are reported separately')
    settings.nodePath = '/adopted/node'
    settings.reaEntry = '/adopted/rea.mjs'
    await assert.rejects(owner.reaComponentsController.removeManagedEnvironment(), /in use by the adopted installation/)
    settings.nodePath = ''
    settings.reaEntry = ''
    const removed = await owner.reaComponentsController.removeManagedEnvironment()
    assert.equal(removed.removed, true)
    assert.equal(removed.bytes, measured.nodeBytes)
    assert.equal(existsSync(join(runtimeDir, 'node')), false, 'the downloaded Node is gone')
    assert.equal(existsSync(join(runtimeDir, 'engine', 'rea6.8.0-abc')), true, 'the installed REA engine is kept')
    assert.equal(existsSync(join(runtimeDir, 'node-24.22.1-rea-6.8.0-darwin-arm64-abc')), true, 'combined generations are never deleted blindly')
    assert.equal(existsSync(join(runtimeDir, 'npm-cache')), true, 'the npm cache is not part of the environment')
  } finally { await ctx.fiber.dispose(); await rm(runtimeDir, { recursive: true, force: true }) }
})

test('the kept runtime is reported and the decision is remembered', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'reakit-keep-'))
  await mkdir(join(runtimeDir, 'node-24.22.1-rea-6.8.0-darwin-arm64-abc', 'engine'), { recursive: true })
  await writeText(join(runtimeDir, 'node-24.22.1-rea-6.8.0-darwin-arm64-abc', 'engine', 'ready.json'), '{}')
  const settings = { enabled: true, runtimeDir, nodePath: '', reaEntry: '', managedReaVersion: '', managedNodeRange: '', keepManagedRuntime: false }
  const edits = []
  const ctx = new Context()
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: {}, retrySetup: async () => {}, getRuntimeState: () => ({ phase: 'ready' }), versions: { status: () => ({}) },
      configuration: { read: () => settings, writable: () => true, entryId: () => 'rea', preferences: async patch => { Object.assign(settings, patch); return { saved: true } } },
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    assert.equal((await owner.reaComponentsController.managedEnvironment()).kept, false)
    const kept = await owner.reaComponentsController.keepManagedEnvironment()
    assert.equal(kept.kept, true)
    settings.keepManagedRuntime = true
    assert.equal((await owner.reaComponentsController.managedEnvironment()).kept, true)
  } finally { await ctx.fiber.dispose(); await rm(runtimeDir, { recursive: true, force: true }) }
})

test('node choices mark the managed Node and refuse an impossible range', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-nodes-'))
  const dir = join(base, 'rea-agents')
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeText(join(dir, 'scripts', 'rea.mjs'), 'export {}\n')
  const writeRange = range => writeText(join(dir, 'package.json'), JSON.stringify({ name: 'rea-agents', version: '6.9.0', engines: { node: range } }))
  await writeRange('>=20.0.0')
  const entry = join(dir, 'scripts', 'rea.mjs')
  const ctx = new Context()
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: {},
      configuration: { read: () => ({ enabled: true }), writable: () => true },
      retrySetup: async () => {},
      getRuntimeState: () => ({ phase: 'ready', nodePath: process.execPath, nodeVersion: 'v26.13.0' }),
      versions: { status: () => ({}) },
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const choices = await owner.reaComponentsController.detectNodes(entry)
    assert.equal(choices.range, '>=20.0.0')
    assert.ok(choices.nodes.length >= 1)
    assert.equal(choices.nodes[0].managed, true, 'the managed Node is offered first')
    assert.equal(choices.managedCompatible, true)
    await writeRange('^18.0.0')
    const impossible = await owner.reaComponentsController.detectNodes(entry)
    assert.equal(impossible.managedCompatible, false, 'an impossible range is reported, not silently accepted')
    await assert.rejects(owner.reaComponentsController.detectNodes(''), /reaEntry is required/)
  } finally { await ctx.fiber.dispose() }
})

test('host refuses to disable REA while tool calls are in flight', async () => {
  const ctx = new Context()
  const writes = []
  let inflight = 1
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: { describe: async () => ({ runtime: { phase: 'ready' } }) },
      configuration: {
        writable: () => true, read: () => ({ enabled: true }),
        enabled: async enabled => { writes.push(enabled); return { saved: true, enabled } },
      },
      getActivity: () => ({ inflight, tools: [] }),
      getRuntimeState: () => ({ phase: 'ready' }),
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    await assert.rejects(async () => owner.reaComponentsController.setEnabled(false), /running 1 tool call.*wait for them to finish/i)
    assert.deepEqual(writes, [], 'no configuration write may be attempted')
    inflight = 0
    await owner.reaComponentsController.setEnabled(false)
    assert.deepEqual(writes, [false])
    inflight = 3
    await owner.reaComponentsController.setEnabled(true)
    assert.deepEqual(writes, [false, true], 'enabling is never blocked by call activity')
  } finally { await ctx.fiber.dispose() }
})

test('an unfocused window polls gently and a focused one polls fast', async () => {
  let exported, reads = 0
  const target = new EventTarget(), timers = new Map()
  const document = { visibilityState: 'visible', hasFocus: () => focus }
  let focus = true
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => ({})) } } }, document }
  vm.runInNewContext(await readFile(new URL('../client/client.js', import.meta.url), 'utf8'), sandbox)
  const snapshot = { runtime: { phase: 'ready' }, enabled: true, configurationWritable: true, activity: { inflight: 0 } }
  const options = { target, schedule: (callback, delay) => { const id = ++reads + 100; timers.set(id, { callback, delay }); return id }, cancel: id => timers.delete(id) }
  const sync = exported.createStatusSync(async () => { reads++; return snapshot }, () => {}, options)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal([...timers.values()].at(-1).delay, 500, 'a focused window keeps the fast cadence')
  focus = false
  const [id, timer] = [...timers.entries()].at(-1); timers.delete(id); timer.callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal([...timers.values()].at(-1).delay, 2000, 'another app in front slows to 2s, not to a halt')
  const before = reads
  target.dispatchEvent(new Event('focus'))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(reads > before, 'regaining window focus refreshes immediately')
  sync.dispose()
})

test('polling slows down while the tab is hidden and refreshes on return', async () => {
  let exported, reads = 0
  const target = new EventTarget(), timers = new Map()
  const visibility = { state: 'visible', listeners: new Set() }
  const document = {
    get visibilityState() { return visibility.state },
    addEventListener(name, listener) { if (name === 'visibilitychange') visibility.listeners.add(listener) },
    removeEventListener(name, listener) { if (name === 'visibilitychange') visibility.listeners.delete(listener) },
  }
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => ({})) } } }, document }
  vm.runInNewContext(await readFile(new URL('../client/client.js', import.meta.url), 'utf8'), sandbox)
  let snapshot = { runtime: { phase: 'ready' }, enabled: true, configurationWritable: true, activity: { inflight: 0 } }
  const options = { target, schedule: (callback, delay) => { const id = ++reads + 1000; timers.set(id, { callback, delay }); return id }, cancel: id => timers.delete(id) }
  const sync = exported.createStatusSync(async () => { reads++; return snapshot }, () => {}, options)
  await new Promise(resolve => setImmediate(resolve))
  const visibleDelay = [...timers.values()].at(-1).delay
  assert.equal(visibleDelay, 500, 'a visible tab polls twice per second')
  visibility.state = 'hidden'
  snapshot = { ...snapshot, runtime: { phase: 'ready' } }
  const [id, timer] = [...timers.entries()].at(-1); timers.delete(id); timer.callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok([...timers.values()].every(entry => entry.delay >= 6000), 'a hidden tab nearly stops polling')
  const beforeReturn = reads
  visibility.state = 'visible'
  for (const listener of visibility.listeners) listener()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(reads > beforeReturn, 'returning to the tab refreshes immediately (a coalesced refresh may add a second read)')
  sync.dispose()
  assert.equal(visibility.listeners.size, 0, 'dispose removes the visibility listener')
})

test('lightweight owner status never invokes the component probes', async () => {
  const ctx = new Context()
  let state = { phase: 'preparing', message: 'installing' }
  await ctx.plugin(function controller(inner) { new ComponentsController(inner, { manager: { describe: () => assert.fail('status must not probe components') }, configuration: { writable: () => true, read: () => ({ enabled: true }) }, getRuntimeState: () => state }) })
  try {
    assert.throws(() => ctx.reaComponentsController.status(), /restricted to the authenticated host owner/)
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    assert.equal(owner.reaComponentsController.status().runtime.phase, 'preparing')
    state = { phase: 'ready', message: 'connected' }
    assert.deepEqual(owner.reaComponentsController.status(), { runtime: state, settingsEntryId: null, enabled: true, configurationWritable: true, optionalTools: { missingDependency: false }, activity: { inflight: 0, tools: [] }, runtimeVersions: { phase: 'idle', candidate: null, transition: null } })
  } finally { await ctx.fiber.dispose() }
})

test('optional Typert injection never blocks core initialization', () => {
  const registered = []
  const fiber = { dispose: async () => {} }
  const ctx = { get: () => undefined, inject: (names, callback) => { registered.push(names); return fiber } }
  // The fiber is returned so the plugin can dispose the stale remote service on reload.
  assert.equal(registerComponents(ctx, { getRuntimeState: () => ({ phase: 'disabled' }), retrySetup: async () => {} }), fiber)
  assert.deepEqual(registered, [['typert']])
})

test('client registers both real settings entry and only its own bundle detail section', async () => {
  let exported
  const react = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const sandbox = { window: { __ModuleLoader__: { load: ({ id, factory }) => { assert.equal(id, 'dsh-reakit'); exported = factory(name => { assert.equal(name, 'react'); return react }) } } } }
  vm.runInNewContext(await readFile(new URL('../client/client.js', import.meta.url), 'utf8'), sandbox)
  const registrations = []
  exported.apply({ slots: { inject: (_name, callback) => callback(), register: (options, render) => registrations.push({ options, render }) }, connection: { rpc: { call: () => assert.fail('render must not install or RPC by registration') } } })
  assert.deepEqual(registrations.map(item => item.options.name), ['plugins.detail.section', 'settings.section', 'conversation.input.left'])
  assert.equal(registrations[1].options.id, 'dsh-reakit')
  assert.equal(registrations[0].render({ subject: { kind: 'bundle', pkg: { name: 'different-plugin' } } }), null)
  assert.ok(registrations[0].render({ subject: { kind: 'bundle', pkg: { name: 'dsh-reakit' } } }))
  const code = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(code, /\.rpc\.call\('\/api', 'reaComponents\//)
  assert.match(code, /复制配置指令/)
  assert.match(code, /可选工具配置/)
  assert.doesNotMatch(code, /复制 AI 安装指令/)
  assert.ok(!code.includes('确认并实际安装'))
  assert.match(code, /role: 'switch'/)
  assert.ok(!code.includes('fetch('))
})

test('client retries only read requests across a transient host HMR gap', async () => {
  let exported, reads = 0, delays = 0
  const saved = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, next => { saved.push(next) }],
    useRef: value => ({ current: value }),
    useEffect: callback => callback(),
  }
  const sandbox = { AbortController, clearTimeout: () => {}, setTimeout: (callback, delay) => { if (delay === 500 && delays === 0) { delays++; queueMicrotask(callback) }; return 1 } /* fire the retry backoff once, not the 500ms poll */, window: { addEventListener: () => {}, removeEventListener: () => {}, __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => react) } } } }
  vm.runInNewContext(await readFile(new URL('../client/client.js', import.meta.url), 'utf8'), sandbox)
  const registrations = []
  exported.apply({ slots: { inject: (_name, callback) => callback(), register: (_options, render) => registrations.push(render) }, connection: { rpc: { call: async (_channel, endpoint) => {
    assert.equal(endpoint, 'reaComponents/status')
    if (++reads === 1) return { ok: false, error: { code: 'gateway/service-unavailable', message: 'HMR in progress' } }
    return { ok: true, value: { runtime: { phase: 'ready' }, enabled: true, configurationWritable: true } }
  } } } })
  const panel = registrations[1]()
  panel.type(panel.props)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 2)
  assert.equal(delays, 1)
  assert.ok(saved.some(value => value && value.runtime?.phase === 'ready'))
})

test('lightweight polling moves preparing to ready and synchronizes mounted surfaces without probes', async () => {
  let exported, sequence = 0, reads = 0
  const target = new EventTarget(), timers = new Map(), snapshots = [[], []]
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => ({})) } } } }
  vm.runInNewContext(await readFile(new URL('../client/client.js', import.meta.url), 'utf8'), sandbox)
  let snapshot = { runtime: { phase: 'preparing' }, enabled: true, configurationWritable: true }
  const options = { target, schedule: (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence }, cancel: id => timers.delete(id) }
  const syncs = snapshots.map(saved => exported.createStatusSync(async () => { reads++; return snapshot }, value => saved.push(value), options))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 2)
  assert.ok([...timers.values()].every(timer => timer.delay === 500), 'a visible, armed tab polls twice per second')
  snapshot = { runtime: { phase: 'ready' }, enabled: true, configurationWritable: true }
  const [id, timer] = [...timers.entries()][0]; timers.delete(id); timer.callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(snapshots[0].at(-1).runtime.phase, 'ready')
  assert.ok([...timers.values()].some(timer => timer.delay === 500), 'ready polling stays at the armed cadence')
  // An in-flight REA call tightens the cadence so the indicator can appear.
  snapshot = { runtime: { phase: 'ready' }, enabled: true, configurationWritable: true, activity: { inflight: 1, tools: ['mcp__rea__open_binary'] } }
  const [busyId, busyTimer] = [...timers.entries()][0]; timers.delete(busyId); busyTimer.callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok([...timers.values()].some(timer => timer.delay === 300), 'active calls poll faster')
  snapshot = { runtime: { phase: 'disabled' }, enabled: false, configurationWritable: true }
  target.dispatchEvent(new Event('dsh-reakit:configuration-changed'))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(snapshots.every(saved => saved.at(-1).enabled === false))
  const beforeFocus = reads
  target.dispatchEvent(new Event('focus'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, beforeFocus + 2)
  syncs.forEach(sync => sync.dispose())
  assert.equal(timers.size, 0)
  const afterDispose = reads
  target.dispatchEvent(new Event('focus')); target.dispatchEvent(new Event('dsh-reakit:configuration-changed'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, afterDispose)
})

test('simplified client has no direct component install, configure, or inventory requests', async () => {
  const code = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(!code.includes('data-rea-component'))
  assert.ok(!code.includes("h('form'"))
  assert.ok(!code.includes('view.components'))
  assert.doesNotMatch(code, /rpc\('(describe|previewInstall|install|configure|retrySetup)'/)
  assert.match(code, /data-rea-optional-tools/)
})

test('shipped registry accepts descriptors and cleans them on dispose', { skip: !existsSync(new URL('../.reference/live-api/dsh-typert-registry/lib/index.js', import.meta.url)) }, async () => {
  const { TypertRegistry } = await import('../.reference/live-api/dsh-typert-registry/lib/index.js')
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  try {
    const dispose = ctx.typert.register(COMPONENTS_TYPERT)
    assert.equal(ctx.typert.local.get('reaComponents/install').service, 'reaComponentsController')
    dispose()
    assert.equal(ctx.typert.local.get('reaComponents/install'), undefined)
  } finally { await ctx.fiber.dispose() }
})

test('the Node environment can be switched without touching the REA entry', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reakit-node-env-'))
  const dir = join(base, 'rea-agents')
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeText(join(dir, 'scripts', 'rea.mjs'), 'export {}\n')
  await writeText(join(dir, 'package.json'), JSON.stringify({ name: 'rea-agents', version: '6.8.0', engines: { node: '>=20.0.0' } }))
  const entry = join(dir, 'scripts', 'rea.mjs')
  const writes = []
  const settings = { enabled: true, nodePath: '/old/node', reaEntry: entry, managedReaVersion: '6.8.0', managedNodeRange: '>=20.0.0' }
  const ctx = new Context()
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: {}, retrySetup: async () => {}, versions: { status: () => ({}) },
      getRuntimeState: () => ({ phase: 'ready', nodePath: '/old/node', nodeVersion: 'v24.22.1' }),
      configuration: {
        read: () => settings, writable: () => true, entryId: () => 'rea',
        nodePathOnly: async (nodePath, expected) => { writes.push({ nodePath, expected }); return { saved: true } },
        preferences: async () => ({ saved: true }),
      },
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const view = await owner.reaComponentsController.nodeEnvironment()
    assert.equal(view.reaVersion, '6.8.0')
    assert.ok(view.nodes.length >= 1, 'the host Node is offered')
    const result = await owner.reaComponentsController.setNodeEnvironment(process.execPath)
    assert.equal(result.saved, true)
    assert.equal(writes.at(-1).nodePath, process.execPath)
    assert.deepEqual(writes.at(-1).expected, { nodePath: '/old/node' }, 'compares the current Node only')
    await assert.rejects(owner.reaComponentsController.setNodeEnvironment(''), /Node path is required/)
  } finally { await ctx.fiber.dispose() }
})

test('deleting the managed Node is refused while it is still in use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-node-remove-'))
  const { runtimeLayout } = await import('../lib/bootstrap.js')
  const layout = runtimeLayout(join(root, 'runtime'))
  await mkdir(layout.nodeDirectory, { recursive: true })
  const ctx = new Context()
  const settings = { enabled: true, runtimeDir: join(root, 'runtime'), nodePath: layout.nodePath, reaEntry: layout.reaEntry, managedReaVersion: '6.8.0', managedNodeRange: '>=20' }
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: {}, retrySetup: async () => {}, versions: { status: () => ({}) },
      getRuntimeState: () => ({ phase: 'ready' }),
      configuration: { read: () => settings, writable: () => true, entryId: () => 'rea' },
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    await assert.rejects(owner.reaComponentsController.removeManagedNode(), /still configured|switch to another Node first/)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('the node panel reports the space a reinstall costs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reakit-node-size-'))
  const { runtimeLayout } = await import('../lib/bootstrap.js')
  const layout = runtimeLayout(join(root, 'runtime'))
  const engine = join(root, 'engine', 'test')
  await mkdir(join(engine, 'scripts'), { recursive: true })
  await writeText(join(engine, 'scripts', 'rea.mjs'), 'export {}\n')
  await writeText(join(engine, 'package.json'), JSON.stringify({ name: 'rea-agents', version: '6.8.0', engines: { node: '>=20' } }))
  const ctx = new Context()
  const settings = { enabled: true, runtimeDir: join(root, 'runtime'), nodePath: '/opt/homebrew/bin/node', reaEntry: join(engine, 'scripts', 'rea.mjs'), managedReaVersion: '6.8.0', managedNodeRange: '>=20' }
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, { manager: {}, retrySetup: async () => {}, versions: { status: () => ({}) }, getRuntimeState: () => ({ phase: 'ready', nodePath: '/opt/homebrew/bin/node', nodeVersion: 'v26.13.0' }), configuration: { read: () => settings, writable: () => true, entryId: () => 'rea' } })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const view = await owner.reaComponentsController.nodeEnvironment()
    assert.equal(view.managedNodePresent, false)
    assert.ok(view.managedNodeEstimate > 100e6, 'an install estimate is reported')
    assert.ok('managedNodeDownload' in view)
    assert.equal(view.managedNodePath, layout.nodePath)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('the controller exposes the managed and engine-only installers it is given', async () => {
  const ctx = new Context()
  let called = null
  await ctx.plugin(function controller(inner) {
    new ComponentsController(inner, {
      manager: { describe: async () => ({ runtime: { phase: 'ready' } }) },
      configuration: { read: () => ({ enabled: true, reaEntry: '/tmp/rea.mjs' }), writable: () => true, entryId: () => 'rea' },
      retrySetup: async () => {},
      getRuntimeState: () => ({ phase: 'ready' }),
      installManagedRuntime: async () => { called = 'managed'; return { nodePath: '/r/node' } },
      versions: { status: () => ({}) },
    })
  })
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const result = await owner.reaComponentsController.installManagedNode()
    assert.equal(called, 'managed')
    assert.equal(result.nodePath, '/r/node')
  } finally { await ctx.fiber.dispose() }
})
