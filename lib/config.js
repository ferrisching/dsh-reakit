import { execFile } from 'node:child_process'
import semver from 'semver'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
export const REA_VERSION = '6.9.0'
export const REA_NODE_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1'

export function supportsReaNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) return false
  const [, major, minor, patch] = match.map(Number)
  if (major === 22) return minor > 23 || (minor === 23 && patch >= 4)
  if (major === 24) return minor > 22 || (minor === 22 && patch >= 1)
  return major > 26 || (major === 26 && (minor > 12 || (minor === 12 && patch >= 1)))
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${name} must be an absolute local path`)
  }
  return value
}

function boundedInteger(value, fallback, name) {
  const number = value ?? fallback
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer <= 2147483647`)
  }
  return number
}

/** Tool families published by REA 6.9.0, with the tools each advertises. */
// tools, advertised bytes and scope per family, measured on REA 6.9.0 with the
// compact input-schema profile; the byte figures are what the model request pays for.
const FAMILY_TABLE = [
  ['direct', 41, 34815,
    '反汇编读写：当前地址、函数、指令、字节与字符串搜索、重命名、注释、书签、交叉引用',
    'Disassembly read/write: current address, functions, instructions, byte and string search, renames, comments, bookmarks, cross-references'],
  ['enhanced', 15, 16319,
    '增强分析：反编译、调用图、ObjC/Swift 类型、原生值追踪、功能与 UI 动作追踪',
    'Deeper analysis: decompilation, call graphs, ObjC/Swift types, native value tracing, feature and UI-action tracing'],
  ['native', 37, 54587,
    '原生二进制与调试：Mach-O/PE/ELF 结构、签名与 plist、gdb/rizin 会话、UI 与调用观测、内核与固件模块',
    'Native binaries and debugging: Mach-O/PE/ELF structure, signatures and plists, gdb/rizin sessions, UI and call observation, kernel and firmware modules'],
  ['artifact', 25, 53389,
    '工件解析：IL2CPP、Go、Rust、pyc、BEAM、WASM、V8 缓存、SQLite、EVM、APK 签名、抓包与信号解码',
    'Artifact parsing: IL2CPP, Go, Rust, pyc, BEAM, WASM, V8 code cache, SQLite, EVM, APK signatures, capture and signal decoding'],
  ['managed', 7, 10025,
    '托管代码：类与成员结构、成员比较、原生边界验证、重建导入',
    'Managed code: class and member structure, member comparison, native-boundary verification, reconstruction import'],
  ['firmware', 2, 3616,
    '固件：区域检查与提取',
    'Firmware: region inspection and extraction'],
  ['android', 6, 8624,
    'Android 静态分析：APK、JNI 绑定、类与方法查询、引用追踪',
    'Android static analysis: APK, JNI bindings, class and method lookup, reference tracing'],
  ['pcap', 2, 1942,
    '抓包：客户端探测与捕获文件检查',
    'Packet capture: client detection and capture-file inspection'],
  ['flutter', 2, 3011,
    'Flutter：构建识别与 Dart AOT 检查',
    'Flutter: build identification and Dart AOT inspection'],
  ['frida', 9, 10451,
    'Frida 动态注入：设备与进程枚举、会话、脚本加载',
    'Frida instrumentation: device and process listing, sessions, script loading'],
  ['apktool', 2, 3851,
    'apktool：Android 资源解码',
    'apktool: Android resource decoding'],
  ['jeb', 4, 2955,
    'JEB：工程打开、单元列表、反编译',
    'JEB: project opening, unit listing, decompilation'],
  ['adb', 24, 19982,
    'ADB 设备操作：包管理、文件推拉、日志、截图、进程与设置',
    'ADB device control: package management, file push/pull, logs, screenshots, processes and settings'],
  ['browser', 12, 25417,
    '浏览器：目标与页面检查、Web Bundle 分析、截图与网络捕获',
    'Browser: target and page inspection, web-bundle analysis, screenshots and network capture'],
  ['electron', 6, 10457,
    'Electron：fuses、目标枚举、页面检查、JS 应用分析与场景捕获',
    'Electron: fuses, target listing, page inspection, JS application analysis, scenario capture'],
  ['javascript-runtime', 2, 1996,
    'JS 运行时：目标枚举与行为观测',
    'JavaScript runtime: target listing and behaviour observation'],
  ['application', 35, 63563,
    '应用级工作流：分析设置与指南、API 契约、版本比较、重建账本、构建计算机',
    'Application workflows: analysis settings and guidance, API contracts, version comparison, reconstruction ledger, build computers'],
  ['session', 24, 36055,
    '会话与证据：打开二进制/捆绑、证据导入导出、函数与工件比较、未知项管理、导航',
    'Session and evidence: open binaries and bundles, evidence import/export, function and artifact comparison, unknowns, navigation'],
]
export const TOOL_FAMILIES = Object.freeze(FAMILY_TABLE.map(([id, tools, bytes, zh]) => Object.freeze({ id, tools, bytes, purpose: zh })))
export const TOOL_FAMILY_IDS = Object.freeze(TOOL_FAMILIES.map(family => family.id))

/** Pure projection: never resolves npx, installs packages, or executes a shell. */
export function buildMcpConfig(settings = {}) {
  const nodePath = absolutePath(settings.nodePath, 'nodePath')
  const reaEntry = absolutePath(settings.reaEntry, 'reaEntry')
  const cwd = settings.cwd ? absolutePath(settings.cwd, 'cwd') : dirname(dirname(reaEntry))
  const serverName = settings.serverName ?? 'rea'
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) throw new Error('Invalid serverName')
  const input = settings.inputSchemaProfile ?? 'compact'
  // Published REA 6.9.0 supports full/off only; main docs describe a later compact mode.
  const output = settings.outputSchemaProfile ?? 'off'
  if (!['compact', 'full'].includes(input)) throw new Error('Invalid inputSchemaProfile')
  if (!['full', 'off'].includes(output)) throw new Error('Invalid outputSchemaProfile for rea-agents@6.9.0 (expected full or off)')
  const env = { NODE_OPTIONS: '', NODE_PATH: '' }
  if (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
    throw new Error('env must be a dictionary of REA_*, GHIDRA_INSTALL_DIR and JAVA_HOME string values')
  }
  for (const [key, value] of Object.entries(settings.env ?? {})) {
    if ((!/^REA_[A-Z0-9_]+$/.test(key) && !['GHIDRA_INSTALL_DIR', 'JAVA_HOME'].includes(key)) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('env accepts only REA_*, GHIDRA_INSTALL_DIR and JAVA_HOME string values without null bytes')
    }
    env[key] = value
  }
  env.REA_MCP_INPUT_SCHEMA_PROFILE = input
  env.REA_MCP_OUTPUT_SCHEMA_PROFILE = output
  const families = settings.toolFamilies ?? []
  if (!Array.isArray(families)) throw new Error('toolFamilies must be a list of tool family ids')
  const unknown = families.filter(id => !TOOL_FAMILY_IDS.includes(id))
  if (unknown.length) throw new Error(`Unknown tool family: ${unknown.join(', ')}`)
  // The full catalogue is registered once; scope is a per-step visibility
  // condition in DSH, not an REA restart with a different family list.
  delete env.REA_MCP_TOOL_FAMILIES
  return {
    transport: 'stdio',
    serverName,
    command: nodePath,
    args: [reaEntry, 'mcp'],
    cwd,
    env,
    toolCallTimeoutMs: boundedInteger(settings.toolCallTimeoutMs, 450_000, 'toolCallTimeoutMs'),
    maxInstructionBytes: 32_768,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30_000, maxAttempts: 3 },
  }
}

/** Check trusted launch paths before the official MCP client owns the process. */
export async function inspectInstallation(settings, expectations = {}) {
  const expectedReaVersion = expectations.reaVersion ?? REA_VERSION
  const expectedNodeRange = expectations.nodeRange ?? REA_NODE_RANGE
  if (semver.valid(expectedReaVersion) === null || semver.validRange(expectedNodeRange) === null) throw new Error('Invalid expected REA or Node version contract')
  const config = buildMcpConfig(settings)
  const nodePath = await realpath(config.command)
  const reaEntry = await realpath(config.args[0])
  const cwd = await realpath(config.cwd)
  if (!(await stat(nodePath)).isFile()) throw new Error('nodePath must identify an executable file')
  if (!(await stat(reaEntry)).isFile()) throw new Error('reaEntry must identify a file')
  if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must identify a directory')
  const root = dirname(dirname(reaEntry))
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (metadata.name !== 'rea-agents' || metadata.version !== expectedReaVersion) {
    throw new Error(`Expected rea-agents@${expectedReaVersion}; other releases need compatibility review`)
  }
  if (metadata.engines?.node !== expectedNodeRange) {
    throw new Error('REA Node engine contract differs from the reviewed release')
  }
  const canonicalEntry = await realpath(join(root, 'scripts', 'rea.mjs'))
  if (canonicalEntry !== reaEntry) throw new Error('reaEntry must be the package scripts/rea.mjs entry')
  // Preload hooks inherited from a developer shell must not run during preflight.
  const { stdout } = await runFile(nodePath, ['--version'], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    timeout: 5000,
    maxBuffer: 4096,
    windowsHide: true,
  })
  const nodeVersion = stdout.trim()
  if (!(expectations.nodeRange ? semver.satisfies(nodeVersion, expectedNodeRange) : supportsReaNode(nodeVersion))) {
    throw new Error(`REA ${expectedReaVersion} requires Node ${expectedNodeRange}; selected runtime is ${nodeVersion}`)
  }
  return {
    reaVersion: metadata.version,
    nodeVersion,
    nodeRange: expectedNodeRange,
    // Canonical paths prevent a working-directory change from altering resolution.
    config: { ...config, command: nodePath, args: [reaEntry, 'mcp'], cwd },
  }
}
