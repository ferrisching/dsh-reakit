import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildMcpConfig, inspectInstallation, supportsReaNode, REA_VERSION, REA_NODE_RANGE } from '../lib/config.js'

const exec = promisify(execFile)
const launch = { nodePath: '/trusted runtime/node', reaEntry: '/trusted rea/scripts/rea.mjs' }

for (const version of ['v22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', '27.0.0']) {
  test(`accepts reviewed Node range: ${version}`, () => assert.equal(supportsReaNode(version), true))
}
for (const version of ['20.99.0', '22.23.3', '23.99.0', '24.21.0', '24.22.0', '25.99.0', '26.11.0', '26.12.0', '26.12.1-rc.1', 'junk']) {
  test(`rejects unsupported Node: ${version}`, () => assert.equal(supportsReaNode(version), false))
}

test('stdio launch is fixed, direct, compact, bounded and free of shell/package runners', () => {
  const config = buildMcpConfig(launch)
  assert.equal(config.command, launch.nodePath)
  assert.deepEqual(config.args, [launch.reaEntry, 'mcp'])
  assert.equal(config.cwd, '/trusted rea')
  assert.equal(config.transport, 'stdio')
  assert.equal(config.serverName, 'rea')
  assert.equal(config.env.REA_MCP_INPUT_SCHEMA_PROFILE, 'compact')
  assert.equal(config.env.REA_MCP_OUTPUT_SCHEMA_PROFILE, 'off')
  assert.equal(config.env.NODE_OPTIONS, '')
  assert.equal(config.env.NODE_PATH, '')
  assert.equal(config.failOnStartupError, true)
  assert.equal(config.reconnect.maxAttempts, 3)
  assert.ok(config.toolCallTimeoutMs > 0)
})

test('supports explicit REA provider configuration, without arbitrary environment injection', () => {
  const config = buildMcpConfig({ ...launch, env: { REA_GHIDRA_PATH: '/tools/ghidra' } })
  assert.equal(config.env.REA_GHIDRA_PATH, '/tools/ghidra')
  for (const key of ['NODE_OPTIONS', 'PATH', 'HOME', 'DSH_TOKEN']) {
    assert.throws(() => buildMcpConfig({ ...launch, env: { [key]: 'value' } }), /REA_\*/)
  }
  assert.throws(() => buildMcpConfig({ ...launch, env: { REA_BAD: 'a\0b' } }))
  assert.throws(() => buildMcpConfig({ ...launch, env: [] }))
})

test('invalid paths, profiles, namespaces and timeouts fail before process launch', () => {
  const invalid = [
    { nodePath: 'npx' }, { reaEntry: './rea.mjs' }, { cwd: 'relative' },
    { nodePath: '/node\0' }, { serverName: 'bad.name' }, { serverName: '' },
    { inputSchemaProfile: 'off' }, { outputSchemaProfile: 'typo' }, { outputSchemaProfile: 'compact' },
    { toolCallTimeoutMs: 0 }, { toolCallTimeoutMs: Infinity }, { toolCallTimeoutMs: 1.5 },
  ]
  for (const change of invalid) assert.throws(() => buildMcpConfig({ ...launch, ...change }))
})

async function fixture(t, version = 'v26.12.1') {
  const prefix = join(tmpdir(), 'dsh-reakit-test-')
  const root = await mkdtemp(prefix)
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(prefix)))
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'scripts'))
  const nodePath = join(root, 'fixture-node')
  // This reports a simulated version; it is deliberately NOT a real REA engine test.
  await writeFile(nodePath, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(version + '\n')})\n`, { mode: 0o755 })
  const reaEntry = join(root, 'scripts', 'rea.mjs')
  await writeFile(reaEntry, 'throw new Error("REA must not run during preflight")\n')
  const metadata = { name: 'rea-agents', version: REA_VERSION, engines: { node: REA_NODE_RANGE } }
  await writeFile(join(root, 'package.json'), JSON.stringify(metadata))
  return { root, settings: { nodePath, reaEntry }, metadata }
}

test('preflight checks package and Node without starting the REA entry', async (t) => {
  const { settings } = await fixture(t)
  const result = await inspectInstallation(settings)
  assert.equal(result.reaVersion, REA_VERSION)
  assert.equal(result.nodeVersion, 'v26.12.1')
  assert.equal(result.config.args[1], 'mcp')
})

test('preflight rejects insufficient runtime', async (t) => {
  const { settings } = await fixture(t, 'v24.21.0')
  await assert.rejects(inspectInstallation(settings), /selected runtime is v24.21.0/)
})

test('preflight rejects wrong package identity, release and engine contract', async (t) => {
  const { root, settings, metadata } = await fixture(t)
  for (const change of [{ name: 'other' }, { version: '6.8.1' }, { engines: { node: '>=20' } }]) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...metadata, ...change }))
    await assert.rejects(inspectInstallation(settings))
  }
})

test('preflight rejects noncanonical REA entry', async (t) => {
  const { root, settings } = await fixture(t)
  const other = join(root, 'scripts', 'other.mjs')
  await writeFile(other, '')
  await assert.rejects(inspectInstallation({ ...settings, reaEntry: other }), /scripts\/rea.mjs/)
})

test('CLI config is non-writing and defaults to the zero-config enabled mode', async () => {
  const { stdout } = await exec(process.execPath, ['bin/dsh-reakit.mjs', 'config', '--node', launch.nodePath, '--entry', launch.reaEntry])
  const [entry] = JSON.parse(stdout)
  assert.equal(entry.name, 'dsh-reakit')
  assert.equal(entry.config.enabled, true)
  assert.equal(entry.config.reaEntry, launch.reaEntry)
})

test('CLI emits a usable default entry without asking for paths', async () => {
  const { stdout } = await exec(process.execPath, ['bin/dsh-reakit.mjs', 'config'])
  const [entry] = JSON.parse(stdout)
  assert.equal(entry.config.enabled, true)
  assert.equal(entry.config.nodePath, undefined)
  assert.equal(entry.config.reaEntry, undefined)
})

test('CLI doctor states the limited scope of its success', async (t) => {
  const { settings } = await fixture(t)
  const { stdout } = await exec(process.execPath, ['bin/dsh-reakit.mjs', 'doctor', '--node', settings.nodePath, '--entry', settings.reaEntry])
  const report = JSON.parse(stdout)
  assert.equal(report.ok, true)
  assert.match(report.scope, /MCP connection and providers not tested/)
})

test('CLI rejects unknown or duplicate options with nonzero status', async () => {
  for (const args of [['unknown'], ['config', '--node'], ['config', '--node', '/a', '--node', '/b']]) {
    await assert.rejects(exec(process.execPath, ['bin/dsh-reakit.mjs', ...args]), { code: 1 })
  }
})

test('the MCP process always lists every family; scope is enforced at registration', async () => {
  const { buildMcpConfig, TOOL_FAMILIES, TOOL_FAMILY_IDS } = await import('../lib/config.js')
  const base = { nodePath: '/node', reaEntry: '/engine/scripts/rea.mjs' }
  // No selection advertises every family.
  assert.equal(buildMcpConfig(base).env.REA_MCP_TOOL_FAMILIES, undefined)
  // A subset is validated but never sent to REA, so changing it cannot restart anything.
  const config = buildMcpConfig({ ...base, toolFamilies: ['native', 'artifact', 'native'], env: { REA_MCP_TOOL_FAMILIES: 'native' } })
  assert.equal(config.env.REA_MCP_TOOL_FAMILIES, undefined)
  // Unknown ids fail before REA starts, so the cause names the offender.
  assert.throws(() => buildMcpConfig({ ...base, toolFamilies: ['native', 'nope'] }), /Unknown tool family: nope/)
  assert.throws(() => buildMcpConfig({ ...base, toolFamilies: 'native' }), /must be a list/)
  // The published family table must stay consistent with itself.
  assert.equal(TOOL_FAMILY_IDS.length, 18)
  assert.equal(TOOL_FAMILIES.reduce((total, family) => total + family.tools, 0), 255)
  assert.equal(new Set(TOOL_FAMILY_IDS).size, TOOL_FAMILY_IDS.length)
})

test('every tool family states what it covers', async () => {
  const { TOOL_FAMILIES } = await import('../lib/config.js')
  for (const family of TOOL_FAMILIES) {
    assert.equal(typeof family.purpose, 'string', `${family.id} needs a scope`)
    assert.ok(family.purpose.length >= 10, `${family.id} scope is too short`)
    assert.ok(family.purpose.includes('：'), `${family.id} scope should read as "what: details"`)
  }
})
