import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Config, inject, createApply } from '../lib/index.js'

const out=resolve(process.argv[2] || '.local/zero-config-acceptance')
await mkdir(out,{recursive:true})
class AcceptanceTools extends Service {
  definitions=new Map()
  constructor(ctx){super(ctx,'tools')}
  register(definition){this.definitions.set(definition.name,definition);return()=>this.definitions.delete(definition.name)}
}
let hooks,networkCalls=0
const originalFetch=globalThis.fetch
// A prepared runtime must be reusable without network even when enabled again.
globalThis.fetch=async()=>{networkCalls++;throw new Error('network intentionally disabled during warm-start acceptance')}
const ctx=new Context()
const checks={}
try {
  await ctx.plugin(AcceptanceTools)
  const plugin={name:'rea-zero-config-acceptance',Config,inject,apply:createApply({register:async(_ctx,value)=>{hooks=value}})}
  const fiber=ctx.plugin(plugin,{})
  await fiber
  assert.equal(hooks.getRuntimeState().phase,'ready')
  checks.defaultOn=ctx.tools.definitions.size
  assert.equal(checks.defaultOn,229)
  const nodePath=hooks.getRuntimeState().nodePath
  const reaEntry=hooks.getRuntimeState().reaEntry
  const result=await ctx.tools.definitions.get('mcp__rea__analyze_javascript_application').execute({input_path:resolve('.local/fixtures/acceptance-app.asar'),format:'asar',detail:'complete'},{signal:AbortSignal.timeout(120000)})
  assert.equal(result.structuredContent.normalized_result.statistics.parsed_javascript_files,2)
  assert.equal(result.structuredContent.normalized_result.statistics.parse_failures,0)
  checks.staticAnalysis=true
  await fiber.update({enabled:false})
  checks.disabledCount=ctx.tools.definitions.size
  assert.equal(checks.disabledCount,0)
  assert.equal(hooks.getRuntimeState().phase,'disabled')
  await fiber.update({enabled:true,autoSetup:false})
  checks.reenabledCount=ctx.tools.definitions.size
  assert.equal(checks.reenabledCount,229)
  assert.equal(hooks.getRuntimeState().nodePath,nodePath)
  assert.equal(hooks.getRuntimeState().reaEntry,reaEntry)
  checks.offlineNetworkRequests=networkCalls
  assert.equal(networkCalls,0)
  await fiber.dispose()
  checks.finalToolCount=ctx.tools.definitions.size
  assert.equal(checks.finalToolCount,0)
  const report={ok:true,scope:'real REA + minimal configuration + real Cordis lifecycle; separate registry, not live GUI',checks,nodePath,reaEntry,finishedAt:new Date().toISOString()}
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  console.log(report)
} finally {globalThis.fetch=originalFetch;await ctx.fiber.dispose()}
