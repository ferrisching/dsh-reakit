import { execFile } from 'node:child_process'
import semver from 'semver'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
export const REA_VERSION = '6.8.0'
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

/** Pure projection: never resolves npx, installs packages, or executes a shell. */
export function buildMcpConfig(settings = {}) {
  const nodePath = absolutePath(settings.nodePath, 'nodePath')
  const reaEntry = absolutePath(settings.reaEntry, 'reaEntry')
  const cwd = settings.cwd ? absolutePath(settings.cwd, 'cwd') : dirname(dirname(reaEntry))
  const serverName = settings.serverName ?? 'rea'
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) throw new Error('Invalid serverName')
  const input = settings.inputSchemaProfile ?? 'compact'
  // Published REA 6.8.0 supports full/off only; main docs describe a later compact mode.
  const output = settings.outputSchemaProfile ?? 'off'
  if (!['compact', 'full'].includes(input)) throw new Error('Invalid inputSchemaProfile')
  if (!['full', 'off'].includes(output)) throw new Error('Invalid outputSchemaProfile for rea-agents@6.8.0 (expected full or off)')
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
