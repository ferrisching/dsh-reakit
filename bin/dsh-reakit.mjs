#!/usr/bin/env node
import { buildMcpConfig, inspectInstallation } from '../lib/config.js'
import { ensureRuntime, runtimeRoot } from '../lib/bootstrap.js'

const HELP = `dsh-reakit: zero-configuration REA plugin helper

Usage:
  dsh-reakit config [--runtime-dir /absolute/data-directory]
  dsh-reakit doctor [--runtime-dir /absolute/data-directory]
  dsh-reakit setup [--runtime-dir /absolute/data-directory]
  dsh-reakit <config|doctor> --node /absolute/node --entry /absolute/rea-agents/scripts/rea.mjs [--cwd /trusted/directory]

config prints a Cordis entry as JSON; it never writes DSH configuration or downloads software.
doctor checks an existing installation only, without network or target analysis.
setup explicitly prepares the pinned managed Node/REA runtime (first run needs network).
MCP connectivity and optional provider readiness are separate from these installation checks.
`

async function main(args) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    process.stdout.write(HELP)
    return
  }
  const [command, ...rest] = args
  if (!['config', 'doctor', 'setup'].includes(command)) throw new Error(`Unknown command: ${command}`)
  const fields = { '--node': 'nodePath', '--entry': 'reaEntry', '--cwd': 'cwd', '--runtime-dir': 'runtimeDir' }
  const settings = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = fields[rest[i]]
    if (!key || !rest[i + 1] || rest[i + 1].startsWith('--') || key in settings) throw new Error(`Invalid or repeated option: ${rest[i]}`)
    settings[key] = rest[i + 1]
  }
  const manual = Boolean(settings.nodePath || settings.reaEntry)
  if (manual) buildMcpConfig(settings)
  else runtimeRoot(settings)
  if (command === 'config') {
    process.stdout.write(JSON.stringify([{ id: 'rea', name: 'dsh-reakit', config: { enabled: true, ...settings } }], null, 2) + '\n')
    return
  }
  const result = manual ? await inspectInstallation(settings) : await ensureRuntime({ ...settings, autoSetup: command === 'setup' })
  process.stdout.write(JSON.stringify({
    ok: true,
    scope: 'installation-only; MCP connection and providers not tested',
    reaVersion: result.reaVersion,
    nodeVersion: result.nodeVersion,
    nodePath: result.config.command,
    reaEntry: result.config.args[0],
    cwd: result.config.cwd,
  }, null, 2) + '\n')
}

try { await main(process.argv.slice(2)) }
catch (error) { process.stderr.write(`dsh-reakit: ${error.message}\n`); process.exitCode = 1 }
