import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const MAX_OUTPUT = 96 * 1024
const JAR_SHA256 = '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75'
export const JADX_RELEASE = Object.freeze({
  version: '0.7.1', sha256: JAR_SHA256,
  url: 'https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar',
})

// These are capability groups, not a replacement/filter for REA's MCP catalog.
export const COMPONENTS = Object.freeze([
  { id: 'builtin', name: 'Built-in static analysis', group: 'Built-in', guide: 'Keeps the complete REA tool catalogue: JS/Electron, .NET, Go/Rust, PE/ELF, Apple/Android packages, Flutter/Dart, IL2CPP/Godot, GPU, model files, BEAM/PYC, SQLite, EVM, evidence/comparison/tracing. Some capabilities still depend on platform or target.', builtin: true },
  { id: 'ghidra', name: 'Ghidra', group: 'Native decompilers', keys: ['GHIDRA_INSTALL_DIR'], brew: 'ghidra', link: 'https://github.com/NationalSecurityAgency/ghidra/releases', guide: 'Install official Ghidra with a compatible JDK and select the directory that contains support/analyzeHeadless. Only the directory layout is checked here; no analysis is started. Actual version and platform compatibility is verified by REA open_binary.' },
  { id: 'java', name: 'Java / full JDK', group: 'Ghidra / Android', keys: ['JAVA_HOME'], brew: 'openjdk@21', link: 'https://jdk.java.net/', guide: 'A full JDK is required (including jdk.compiler), not a JRE. JAVA_HOME must point at a directory containing bin/java; the JDK version Ghidra needs follows the selected Ghidra release.' },
  { id: 'jadx', name: 'JADX headless MCP', group: 'Android APK', keys: ['REA_JADX_MCP_JAR'], link: JADX_RELEASE.url, install: 'jar', guide: 'REA 6.8.0 needs jadx-headless-mcp 0.7.1, not the plain brew jadx CLI. The button only downloads the upstream JAR with a reviewed SHA-256 into the plugin directory and runs no scripts; a full JDK is also required. Configure it after installing.' },
  { id: 'wabt', name: 'WABT 1.0.42', group: 'WASM', keys: ['REA_WABT_BIN_DIRECTORY'], brew: 'wabt', link: 'https://github.com/WebAssembly/wabt/releases', guide: 'The directory must contain wasm-validate, wasm-objdump and wasm2wat, all reporting exactly 1.0.42. A Homebrew version mismatch refuses automatic installation.' },
  { id: 'frida', name: 'Frida native binding', group: 'Dynamic instrumentation', native: 'frida', guide: 'Loads frida with the current REA Node and module paths to detect the binding; it never connects to a device or injects into a process. If the binding is missing after ignore-scripts, review the frida@17.23.2 install script, download source and local signing requirements first, then explicitly authorise a scoped repair. This page never allows npm rebuild or global scripts. The device side also needs a matching Frida server, authorisation and connectivity.' },
  { id: 'pty', name: 'Native PTY', group: 'Process behaviour', native: '@lydell/node-pty', guide: 'Actually loads the @lydell/node-pty that the current REA depends on; no pseudo-terminal or target is started. When missing, check the platform optional prebuilt package and repair inside the dedicated runtime with ignore-scripts. Process capture tools stay available and report the reason when unavailable.' },
  { id: 'hopper', name: 'Hopper', group: 'Commercial decompilers', license: true, link: 'https://www.hopperapp.com/', guide: 'Requires a separately purchased licence and official installation; macOS Hopper GUI and bridge permissions are authorised by the user. This page never downloads, activates or auto-installs commercial software.' },
  { id: 'ida', name: 'IDA / IDA MCP', group: 'Commercial decompilers', keys: ['REA_IDA_MCP_CONFIG'], license: true, link: 'https://hex-rays.com/ida-pro', guide: 'Requires an IDA licence that satisfies the upstream requirements, an official installation and optionally an MCP bridge. REA_IDA_MCP_CONFIG is the absolute path of the bridge configuration; only file existence is checked, and credentials inside are never read or echoed.' },
  { id: 'jeb', name: 'JEB MCP', group: 'Commercial Android/Java', keys: ['REA_JEB_MCP_URL'], license: true, link: 'https://www.pnfsoftware.com/jeb/', guide: 'Requires a licence and a JEB MCP client that the user starts manually. A loopback URL such as http://127.0.0.1:8425/mcp may be supplied; this page never connects to the service, starts JEB or handles licensing.' },
  { id: 'adb', name: 'Android platform-tools / adb', group: 'Android devices', keys: ['REA_ADB_PATH'], command: 'adb', args: ['version'], link: 'https://developer.android.com/tools/releases/platform-tools', guide: 'Only runs adb version; it does not start the adb server or enumerate, install to or modify devices. Real use needs an authorised emulator or device plus USB or network debugging authorisation.' },
  { id: 'apktool', name: 'Apktool', group: 'Android resources', keys: ['REA_APKTOOL_COMMAND'], command: 'apktool', args: ['--version'], link: 'https://apktool.org/', guide: 'Select the absolute path of the Apktool launcher; Java is also required. Decoding resources is not the same as recovering Java source.' },
  { id: 'browser', name: 'Browser / CDP / Electron Inspector', group: 'Web / Electron', keys: ['REA_BROWSER_EXECUTABLE'], link: 'https://www.chromium.org/', guide: 'The browser must be supplied by the user under their own authorisation policy. CDP/Inspector needs an explicit loopback endpoint and target; page and process operations need separate authorisation. This page never launches a browser or reuses an unauthorised login session.' },
  { id: 'pwntools', name: 'Python / pwntools', group: 'ELF / recorded crashes', keys: ['REA_PWNTOOLS_PYTHON'], command: 'python3', link: 'https://docs.pwntools.com/', guide: 'Linux x64: the isolated Python needs pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2; pwndbg is optional and configured upstream. This page only locates the interpreter and never reports ready before the Python package versions are verified.' },
  { id: 'gdb', name: 'GDB', group: 'Native debugging', keys: ['REA_GDB_COMMAND'], command: 'gdb', args: ['--version'], linux: true, link: 'https://www.sourceware.org/gdb/', guide: 'Persistent debugger sessions need Linux /proc and a persistent TTY chosen by the user; finding an executable does not mean debugging permission is in place.' },
  { id: 'rizin', name: 'Rizin / Cutter', group: 'Disassembly / debugging', keys: ['REA_RIZIN_COMMAND'], command: 'rizin', args: ['-v'], link: 'https://rizin.re/', guide: 'The Rizin CLI and the Cutter bridge are configured separately; the bridge must be started by the user. Arbitrary commands and plugins can execute code and need separate authorisation.' },
  { id: 'objdump', name: 'GNU objdump', group: 'Offline disassembly', keys: ['REA_OBJDUMP_COMMAND'], command: 'gobjdump', args: ['--version'], link: 'https://www.gnu.org/software/binutils/', guide: 'REA needs GNU objdump; the macOS system objdump is not a GNU implementation. Detection only reports ready when the GNU version string matches.' },
  { id: 'tshark', name: 'TShark / capinfos', group: 'PCAP / packets', keys: ['REA_TSHARK_COMMAND', 'REA_CAPINFOS_COMMAND'], command: 'tshark', args: ['--version'], linux: true, link: 'https://www.wireshark.org/', guide: 'Linux: TShark 4.x, capinfos and util-linux prlimit; this only inspects local tools and never captures traffic. It stays manual/unverified until every component is present.' },
  { id: 'sigrok', name: 'sigrok-cli', group: 'Logic signals', keys: ['REA_SIGROK_COMMAND'], command: 'sigrok-cli', args: ['--version'], linux: true, link: 'https://sigrok.org/', guide: 'Linux: sigrok-cli 0.7.2, libsigrokdecode and prlimit; this page never scans hardware or acquires signals.' },
  { id: 'binwalk', name: 'Binwalk', group: 'Firmware regions', keys: ['REA_BINWALK_COMMAND'], command: 'binwalk', args: ['--version'], linux: true, link: 'https://github.com/ReFirmLabs/binwalk', guide: 'Linux: Binwalk 3.1.x, prlimit and procps ps; it only locates the tool and never processes firmware or runs extractors.' },
  { id: 'unblob', name: 'Unblob', group: 'Firmware extraction', keys: ['REA_UNBLOB_COMMAND'], command: 'unblob', args: ['--version'], linux: true, link: 'https://unblob.org/', guide: 'Linux: Unblob 26.6.x, prlimit, ps and the format-specific extractors; an existing command does not mean the full extraction environment is ready.' },
  { id: 'mitmproxy', name: 'mitmdump', group: 'Offline network capture', command: 'mitmdump', args: ['--version'], linux: true, link: 'https://www.mitmproxy.org/', guide: 'Linux: mitmdump 12.2.3 reads saved native mitmproxy files; it never starts a proxy or captures traffic. HAR/SAZ parsing is a built-in capability.' },
  { id: 'apple', name: 'Apple / Swift / LLDB / Xcode', group: 'Apple native apps', command: 'xcrun', args: ['--version'], darwin: true, link: 'https://developer.apple.com/xcode/', guide: 'macOS with the Apple command line tools the user installed; codesign, assetutil, swift-demangle and LLDB depend on the specific tools and authorisation. UI observation needs Accessibility and Screen Recording; this page never requests permissions or launches a target.' },
])

export const ENV_KEYS = Object.freeze(COMPONENTS.flatMap(row => row.keys ?? []))
const digest = value => createHash('sha256').update(value).digest('hex')
export const messageOf = error => String(error?.message ?? error).slice(0, 4000)
const clean = (value, limit = MAX_OUTPUT) => String(value ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, limit)

export function validateSetting(key, value) {
  if (!ENV_KEYS.includes(key)) throw new Error('This environment variable may not be changed')
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid configuration value')
  if (key === 'REA_JEB_MCP_URL') {
    let url
    try { url = new URL(value) } catch { throw new Error('The JEB endpoint must be a loopback HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('The JEB endpoint must be a credential-free loopback HTTP(S) URL without query or fragment')
  } else if (!isAbsolute(value)) throw new Error('An absolute path is required')
  return value
}

export function aiPrompt(component) {
  const keys = component.keys?.join(', ') || 'no environment variable on this page'
  return `You are configuring ${component.name} for the dsh-reakit plugin already installed in DeepSeek Harness (DSH). This is not a standalone REA installation from the upstream repository tutorial. First inspect read-only: the installed plugin's own README.md, package.json, lib/config.js, lib/bootstrap.js and assets/engine/dependencies.lock.json, plus the current instance configuration, the REA switch and the runtime state. Check only the non-sensitive fields you need, and ask before guessing paths or APIs when the instance cannot be located. Reuse the plugin's verified managed Node / REA and locked dependencies, and keep an existing nodePath / reaEntry manual mode. Do not clone the REA repository, install rea-agents globally, run npx rea or rea setup, add an independent REA service or another MCP client registration, or edit the plugin lockfile. Dependency requirements come from the installed plugin and the REA release it locks; upstream material only helps to cross-check dependencies. ${component.guide} Configurable keys: ${keys}. Prepare only the dependencies this capability needs. First present the source, exact version, verification method, path, install/shared-dependency upgrade plan and impact, and install only after I confirm. Do not upgrade globally, run unreviewed scripts, start targets, devices or browsers, handle commercial licences automatically, or modify the system or DSH Node, PATH, npmrc or other client configuration. After authorisation, use the DSH ConfigEditor to merge only the required env keys into the current dsh-reakit entry, keeping every other setting, and never write ordinary fields through volatile settings; keep the existing enabled, autoSetup, nodePath, reaEntry, runtimeDir, serverName and composer visibility preference unchanged, and ask before changing any of them. Never enable REA while it is disabled. Before enabling or restarting, explain the impact, check the active session and confirm that unsaved evidence was exported; stop when the session state is unknown. Verify the capability minimally through the MCP tools this plugin actually registered in DSH, never substituting a standalone REA CLI or doctor success for plugin readiness, and mark it unverified when REA is disabled or authorisation is missing. Do not read or print credentials, keep diagnostics on failure, and never claim readiness that was not observed.`
}

export async function runCommand(command, args, options = {}) {
  const { stdout, stderr } = await exec(command, args, {
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', JAVA_TOOL_OPTIONS: '', JDK_JAVA_OPTIONS: '', _JAVA_OPTIONS: '' },
    timeout: 8000, maxBuffer: MAX_OUTPUT, windowsHide: true, ...options,
  })
  return { stdout: clean(stdout, options.maxBuffer ?? MAX_OUTPUT), stderr: clean(stderr, options.maxBuffer ?? MAX_OUTPUT) }
}

export function createComponentManager(options = {}) {
  const run = options.run ?? runCommand
  const env = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const read = options.readFile ?? readFile
  const stats = options.stat ?? stat
  const canonical = options.realpath ?? realpath
  const accessible = options.access ?? access
  const now = options.now ?? Date.now
  const runtime = options.getRuntimeState ?? (() => ({ phase: 'idle', message: 'Not initialized yet' }))
  const getSettings = options.getSettings ?? (() => ({}))
  const installRoot = options.installRoot ?? join(homedir(), '.dsh', 'dsh-reakit', 'components')
  const plans = new Map()
  let busy = false
  let lastOperation = null
  let sequence = 0

  async function exists(path, directory = false) {
    try { const s = await stats(path); return directory ? s.isDirectory() : s.isFile() } catch { return false }
  }
  async function locate(command) {
    const candidates = isAbsolute(command ?? '') ? [command] : (env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, command ?? ''))
    for (const candidate of candidates) {
      try { await accessible(candidate, constants.X_OK); return await canonical(candidate) } catch {}
    }
    return undefined
  }
  function effectiveEnv() { return { ...env, ...(getSettings().env ?? {}) } }
  async function probe(row, config) {
    const result = { ...row, status: 'missing', detail: 'Not detected; install or configure it manually', values: {}, suggestions: {}, aiPrompt: aiPrompt(row) }
    delete result.native
    for (const key of row.keys ?? []) if (typeof config[key] === 'string') result.values[key] = config[key]
    if (row.builtin) return { ...result, status: runtime().phase === 'ready' ? 'ready' : 'manual', detail: 'The tool catalogue is never trimmed; actual calls depend on the runtime, platform and input.' }
    if (row.license) {
      const selected = row.keys?.[0] && config[row.keys[0]]
      const detected = selected && (row.id === 'jeb' ? (() => { try { validateSetting(row.keys[0], selected); return true } catch { return false } })() : await exists(selected))
      return { ...result, status: 'license', detail: detected ? 'Configuration detected; the licence and service connection still need user verification, and this page never starts commercial components' : 'Needs a licence, official installation and manual configuration; this page never auto-installs' }
    }
    if (row.linux && platform !== 'linux' || row.darwin && platform !== 'darwin') return { ...result, status: 'manual', detail: `This capability requires ${row.linux ? 'Linux' : 'macOS'}; the current platform is ${platform}, so the tool stays registered but is not claimed usable` }
    if (row.native) {
      const state = runtime()
      if (!state.nodePath || !state.reaEntry) return { ...result, status: 'manual', detail: 'Waiting for the current Node/REA runtime paths; never falls back to a project cache' }
      const script = `const {createRequire}=require('node:module');const m=createRequire(process.argv[1])(${JSON.stringify(row.native)});if(!m||typeof m[${JSON.stringify(row.id === 'pty' ? 'spawn' : 'getDeviceManager')}]!=='function')throw new Error('native export unavailable');process.stdout.write('binding-loaded')`
      try { await run(state.nodePath, ['-e', script, state.reaEntry]); return { ...result, status: 'ready', detail: 'The current REA native module loaded successfully; no target, PTY or device was started' } } catch (error) { return { ...result, status: 'manual', detail: `Native binding not ready: ${messageOf(error)}` } }
    }
    if (row.id === 'ghidra') {
      const candidates = [config.GHIDRA_INSTALL_DIR, '/opt/homebrew/opt/ghidra/libexec', '/usr/local/opt/ghidra/libexec'].filter(Boolean)
      for (const dir of candidates) if (isAbsolute(dir) && await exists(join(dir, 'support', platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless'))) {
        const value = await canonical(dir)
        return { ...result, status: config.GHIDRA_INSTALL_DIR === value ? 'ready' : 'manual', detail: 'Ghidra headless files detected; the engine was not started and a compatible JDK is required', suggestions: { GHIDRA_INSTALL_DIR: value } }
      }
      return result
    }
    if (row.id === 'java') {
      const candidates = config.JAVA_HOME ? [join(config.JAVA_HOME, 'bin', platform === 'win32' ? 'java.exe' : 'java')] : ['/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java', '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java', 'java']
      let java
      for (const candidate of candidates) { java = await locate(candidate); if (java) break }
      if (!java) return result
      try {
        const output = await run(java, ['--list-modules'])
        if (!/^jdk\.compiler@/m.test(output.stdout)) return { ...result, status: 'manual', detail: 'Java detected, but the jdk.compiler module of a full JDK was not found' }
        const home = dirname(dirname(java))
        return { ...result, status: 'ready', detail: `Full JDK detected: ${clean(output.stdout.match(/^java\.base@.+$/m)?.[0] ?? '')}`, suggestions: { JAVA_HOME: home } }
      } catch (error) { return { ...result, status: 'manual', detail: `Java detection failed: ${messageOf(error)}` } }
    }
    if (row.id === 'jadx') {
      const file = config.REA_JADX_MCP_JAR || join(installRoot, 'jadx-headless-mcp-0.7.1-all.jar')
      if (isAbsolute(file) && await exists(file)) {
        const size = (await stats(file)).size
        const match = size <= 128 * 1024 * 1024 && digest(await read(file)) === JAR_SHA256
        return { ...result, status: 'manual', detail: match ? 'JAR verified against the pinned SHA-256; the path and a full JDK still need configuring, and REA verifies the bridge launch' : 'A JAR exists but does not match the reviewed 0.7.1 SHA-256; not marked ready', suggestions: match ? { REA_JADX_MCP_JAR: file } : {} }
      }
      return result
    }
    if (row.id === 'wabt') {
      const executable = await locate('wasm-validate')
      const directory = config.REA_WABT_BIN_DIRECTORY || (executable && dirname(executable))
      if (!directory || !isAbsolute(directory)) return result
      try {
        for (const tool of ['wasm-validate', 'wasm-objdump', 'wasm2wat']) {
          const output = await run(join(directory, tool), ['--version'])
          if (output.stdout.trim() !== '1.0.42' || output.stderr.trim()) throw new Error(`${tool} must report 1.0.42 with empty stderr`)
        }
        return { ...result, status: config.REA_WABT_BIN_DIRECTORY ? 'ready' : 'manual', detail: 'All three WABT tools verified as 1.0.42; no target was parsed', suggestions: { REA_WABT_BIN_DIRECTORY: directory } }
      } catch (error) { return { ...result, status: 'manual', detail: `WABT detection failed: ${messageOf(error)}` } }
    }
    const key = row.keys?.[0]
    const selected = key && config[key]
    const path = row.command ? await locate(selected || (row.id === 'objdump' && platform !== 'darwin' ? 'objdump' : row.command)) : selected
    if (!path || !isAbsolute(path) || !await exists(path)) return result
    if (key) result.suggestions[key] = path
    if (!row.args) return { ...result, status: 'manual', detail: 'Path detected; full dependencies, version and execution permission are unverified' }
    try {
      const output = await run(path, row.args)
      const text = `${output.stdout}\n${output.stderr}`.trim()
      if (row.id === 'objdump' && !/GNU objdump/.test(text)) throw new Error('Not GNU objdump')
      const limited = ['tshark', 'sigrok', 'binwalk', 'unblob', 'mitmproxy', 'apple'].includes(row.id)
      return { ...result, status: limited ? 'manual' : 'ready', detail: `${text.split('\n').slice(0, 2).join(' ').slice(0, 350)}${limited ? '; full version/platform and helper dependencies still need REA verification' : '; version check only, no analysis was started'}` }
    } catch (error) { return { ...result, status: 'manual', detail: `Detection failed: ${messageOf(error)}` } }
  }

  async function describe() {
    const config = effectiveEnv()
    const rows = await Promise.all(COMPONENTS.map(async row => {
      try { return await probe(row, config) } catch (error) { return { ...row, status: 'error', detail: messageOf(error), values: {}, suggestions: {}, aiPrompt: aiPrompt(row) } }
    }))
    const ghidra = rows.find(row => row.id === 'ghidra')
    if (ghidra?.status === 'ready' && rows.find(row => row.id === 'java')?.status !== 'ready') {
      ghidra.status = 'manual'
      ghidra.detail += '; the full JDK is not ready, so Ghidra cannot be marked ready'
    }
    return { runtime: runtime(), components: rows, busy, lastOperation, configurationWritable: Boolean(options.configure), platform, note: 'Detection is not a full capability acceptance; no REA tool is ever trimmed. Every install must be previewed and then confirmed.' }
  }
  const brewEnv = { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_INSTALL_UPGRADE: '1', HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' }
  async function brewPlan(row, signal) {
    if (!['darwin', 'linux'].includes(platform)) throw new Error('Homebrew installation is unavailable on this platform; use the official entry point and configure manually')
    const brew = await locate('brew')
    if (!brew) throw new Error('Homebrew not found; this page never installs a package manager, so install the component manually from its official entry point')
    const version = await run(brew, ['--version'], { env: brewEnv, signal })
    const info = await run(brew, ['info', '--json=v2', row.brew], { env: brewEnv, signal, timeout: 30000 })
    const parsed = JSON.parse(info.stdout)
    const formula = parsed.formulae?.find(item => item.name === row.brew || item.full_name === row.brew)
    const cask = parsed.casks?.find(item => item.token === row.brew)
    if (Boolean(formula) === Boolean(cask)) throw new Error('Ambiguous Homebrew package identity; refusing to run automatically')
    if (formula?.installed?.length || cask?.installed) throw new Error('The target is already installed by Homebrew; this page never upgrades or reinstalls implicitly, so detect/configure it first')
    if (row.id === 'wabt' && formula?.versions?.stable !== '1.0.42') throw new Error(`Homebrew WABT is ${formula?.versions?.stable ?? 'unknown'} but upstream requires 1.0.42; refusing to auto-install an incompatible version`)
    const args = ['install', formula ? '--formula' : '--cask', ...(formula ? ['--force-bottle'] : []), row.brew]
    // Bind metadata for the dependency closure too: a same-name dry-run alone
    // does not notice a dependency's version/revision changing. This is still
    // a plan binding, not a lockfile/SRI guarantee or a cross-process Brew lock.
    const dependencies = await run(brew, ['deps', '--full-name', '--include-build', '--include-implicit', row.brew], { env: brewEnv, signal, timeout: 30000 })
    const pending = new Set([...dependencies.stdout.trim().split(/\s+/).filter(Boolean), ...(cask?.depends_on?.cask ?? [])])
    const seen = new Set([row.brew])
    const closure = []
    const metadata = []
    while (pending.size) {
      const names = [...pending].filter(name => !seen.has(name)).sort()
      pending.clear()
      if (!names.length) break
      if (seen.size + names.length > 128 || names.some(name => !/^[A-Za-z0-9][A-Za-z0-9@+_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9@+_.-]*){0,2}$/.test(name))) throw new Error('Homebrew dependency closure exceeds the limit or contains an invalid package name; install manually')
      const response = await run(brew, ['info', '--json=v2', ...names], { env: brewEnv, signal, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
      const values = JSON.parse(response.stdout)
      const records = [...(values.formulae ?? []), ...(values.casks ?? [])]
      if (records.length !== names.length) throw new Error('Incomplete Homebrew dependency metadata; refusing to run automatically')
      metadata.push(response)
      for (const name of names) seen.add(name)
      for (const item of records) {
        closure.push({ name: item.full_name ?? item.token ?? item.name, version: item.versions?.stable ?? item.version, revision: item.revision ?? 0 })
        for (const name of [...(item.dependencies ?? []), ...(item.recommended_dependencies ?? []), ...(item.build_dependencies ?? []), ...(item.depends_on?.formula ?? []), ...(item.depends_on?.cask ?? [])]) if (!seen.has(name)) pending.add(name)
      }
    }
    const installed = await run(brew, ['list', '--versions'], { env: brewEnv, signal, timeout: 15000 })
    const preview = await run(brew, [...args.slice(0, -1), '--dry-run', row.brew], { env: brewEnv, signal, timeout: 30000 })
    const output = [preview.stdout, preview.stderr].filter(Boolean).join('\n').trim()
    if (!output) throw new Error('Homebrew returned no reviewable dry-run plan; refusing to install')
    const fingerprint = digest(JSON.stringify([brew, version, info, dependencies, metadata, installed, preview, args]))
    return { kind: 'brew', componentId: row.id, executable: brew, args, fingerprint, preview: output, package: row.brew, version: formula?.versions?.stable ?? cask.version, source: formula?.urls?.stable?.url ?? cask.url ?? 'official Homebrew metadata', dependencies: closure, warning: 'This plan may install or upgrade shared dependencies. Review the full dry-run output line by line; confirming authorises only this component and the dependency changes listed in the preview. It never runs a global upgrade, never auto-updates or auto-cleans, and never stands in for administrator interaction. The full plan and installed versions are re-checked before anything runs, and any change aborts.' }
  }
  function component(id) {
    const row = COMPONENTS.find(item => item.id === id)
    if (!row || row.license || !(row.brew || row.install)) throw new Error('This component cannot be auto-installed; use its official entry point and the setup prompt')
    return row
  }
  async function previewInstall(componentId, signal) {
    if (busy) throw new Error('Another component operation is still running')
    const row = component(componentId)
    busy = true
    try {
      const plan = row.install === 'jar' ? { kind: 'jar', componentId, package: 'jadx-headless-mcp', version: JADX_RELEASE.version, source: JADX_RELEASE.url, sha256: JAR_SHA256, destination: join(installRoot, 'jadx-headless-mcp-0.7.1-all.jar'), preview: 'Downloads the pinned release JAR (at most 128 MiB), verifies the pinned SHA-256 and writes it into the plugin directory; it never executes the download, runs install scripts, installs Java or overwrites a different existing file.', warning: 'This is a third-party upstream release file; installing it does not mean the REA bridge or Java is verified.' } : await brewPlan(row, signal)
      plans.clear()
      const token = randomUUID()
      plans.set(token, { ...plan, createdAt: now() })
      return { ...plan, token, expiresInSeconds: 300 }
    } finally { busy = false }
  }
  async function install(token, confirm, signal) {
    if (busy) throw new Error('Another component operation is still running')
    if (confirm !== true) throw new Error('You must explicitly confirm the full install and shared-dependency change plan')
    const plan = plans.get(token)
    plans.delete(token)
    if (!plan || now() - plan.createdAt > 300000) throw new Error('The install plan expired; preview it again')
    busy = true
    const operation = ++sequence
    try {
      if (plan.kind === 'brew') {
        const fresh = await brewPlan(component(plan.componentId), signal)
        if (fresh.fingerprint !== plan.fingerprint) throw new Error('The Homebrew plan or installed state changed; nothing was installed, so preview it again')
        await run(plan.executable, plan.args, { env: brewEnv, signal, timeout: 20 * 60 * 1000 })
      } else {
        if (!options.installJar) throw new Error('The safe downloader is unavailable; nothing was installed')
        await options.installJar(plan, signal)
      }
      lastOperation = { operation, phase: 'completed', message: 'The install command finished successfully; detect and configure again, and do not claim full readiness from this' }
      return lastOperation
    } catch (error) {
      lastOperation = { operation, phase: 'error', message: messageOf(error) }
      throw error
    } finally { busy = false }
  }
  async function configure(componentId, values) {
    if (busy) throw new Error('Another component operation is still running')
    const row = COMPONENTS.find(item => item.id === componentId)
    if (!row || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid configuration request')
    const entries = Object.entries(values)
    if (!entries.length || entries.some(([key]) => !row.keys?.includes(key))) throw new Error('Only the configuration keys published by this component may be changed')
    const patch = Object.fromEntries(entries.map(([key, value]) => [key, validateSetting(key, value)]))
    for (const [key, value] of Object.entries(patch)) if (key !== 'REA_JEB_MCP_URL' && !await exists(value, ['GHIDRA_INSTALL_DIR', 'JAVA_HOME', 'REA_WABT_BIN_DIRECTORY'].includes(key))) throw new Error(`${key} does not exist as the expected path type`)
    if (!options.configure) throw new Error('ConfigEditor is unavailable; copy the AI setup prompt instead of writing any file')
    busy = true
    try { await options.configure(patch); return { saved: true, message: 'Scoped configuration submitted and awaiting a host reload; detect again to confirm the state' } } finally { busy = false }
  }
  return { describe, previewInstall, install, configure }
}
