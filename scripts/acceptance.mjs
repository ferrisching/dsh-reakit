import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { inspectInstallation } from '../lib/config.js'

// This script invokes the real REA engine. It is opt-in, never part of npm test.
const [configFile, targetPath, outputDirectory] = process.argv.slice(2)
if (!configFile || !targetPath || !outputDirectory) throw new Error('Usage: node scripts/acceptance.mjs CONFIG TARGET_ASAR OUTPUT_DIRECTORY')
const settings = JSON.parse(await readFile(resolve(configFile), 'utf8'))
const prefix = `mcp__${settings.serverName ?? 'rea'}__`
const target = resolve(targetPath)
const out = resolve(outputDirectory)
await mkdir(out, { recursive: true })
const save = async (name, data) => writeFile(join(out, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })

class AcceptanceTools extends Service {
  definitions = new Map()
  constructor(ctx) { super(ctx, 'tools') }
  register(definition) {
    if (this.definitions.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`)
    this.definitions.set(definition.name, definition)
    return () => this.definitions.delete(definition.name)
  }
}

const installation = await inspectInstallation(settings)
const startedAt = new Date().toISOString()
const ctx = new Context()
let fiber
let error
const checks = {}
try {
  await ctx.plugin(AcceptanceTools)
  fiber = ctx.plugin(plugin, settings)
  await fiber
  const definitions = ctx.tools.definitions
  const toolNames = [...definitions.keys()]
  checks.discovery = { count: toolNames.length, names: toolNames }
  assert.ok(toolNames.includes(`${prefix}binary_session`))
  assert.ok(toolNames.includes(`${prefix}analyze_javascript_application`))
  await save('tool-catalog.json', [...definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters })))
  const signal = AbortSignal.timeout(180_000)
  const call = async (name, args) => definitions.get(`${prefix}${name}`).execute(args, { signal })
  const session = await call('binary_session', {})
  await save('binary-session.json', session)
  checks.session = { ok: true }
  const analysis = await call('analyze_javascript_application', { input_path: target, format: 'asar', detail: 'complete' })
  await save('javascript-analysis.json', analysis)
  const serialized = JSON.stringify(analysis)
  assert.match(serialized, /main\.js/)
  assert.match(serialized, /normalize\.js/)
  assert.ok(analysis.structuredContent, 'REA should return structured Evidence')
  const statistics = analysis.structuredContent.normalized_result.statistics
  assert.equal(statistics.parsed_javascript_files, 2)
  assert.equal(statistics.parse_failures, 0)
  checks.javascriptAnalysis = { ok: true, hasStructuredContent: true, expectedFilesObserved: ['main.js', 'normalize.js'], parsedJavascriptFiles: statistics.parsed_javascript_files, parseFailures: statistics.parse_failures }
  await assert.rejects(call('analyze_javascript_application', { input_path: join(out, 'nonexistent-target.asar'), format: 'asar', detail: 'summary' }), (failure) => {
    checks.errorPropagation = { ok: true, message: failure.message }
    return true
  })
  await fiber.dispose()
  assert.equal(definitions.size, 0)
  checks.disposal = { ok: true, registeredToolCountAfterDispose: definitions.size }
} catch (failure) {
  error = failure
} finally {
  await ctx.fiber.dispose()
}
const report = {
  ok: !error,
  scope: 'real REA engine + real Cordis + official MCP bridge; local registry, not the running GUI host',
  startedAt,
  finishedAt: new Date().toISOString(),
  nodeVersion: installation.nodeVersion,
  reaVersion: installation.reaVersion,
  target,
  targetSha256: createHash('sha256').update(await readFile(target)).digest('hex'),
  targetExecution: false,
  checks,
  ...(error ? { error: { message: error.message, stack: error.stack } } : {}),
}
await save('report.json', report)
console.log(JSON.stringify({ ok: report.ok, nodeVersion: report.nodeVersion, reaVersion: report.reaVersion, toolCount: checks.discovery?.count, analysis: checks.javascriptAnalysis, errorPropagation: checks.errorPropagation?.ok, disposal: checks.disposal, report: join(out, 'report.json'), ...(error ? { error: error.message } : {}) }, null, 2))
if (error) process.exitCode = 1
