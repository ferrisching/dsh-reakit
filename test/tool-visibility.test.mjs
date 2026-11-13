import test from 'node:test'
import assert from 'node:assert/strict'
import { createReaToolVisibility } from '../lib/tool-visibility.js'
import { TOOL_TO_FAMILY } from '../lib/tool-family-map.js'
import { CORE_FAMILIES } from '../lib/tool-routing.js'
import { REA_TOOL_NAMES } from '../lib/rea-tool-names.js'

test('the family map covers the whole reviewed catalogue', () => {
  assert.equal(Object.keys(TOOL_TO_FAMILY).length, 255)
  for (const name of REA_TOOL_NAMES) assert.ok(TOOL_TO_FAMILY[name], `${name} needs a family`)
})

test('manual scope is applied without reconnecting anything', () => {
  let settings = { enabled: true, toolRouting: 'manual', toolFamilies: ['native'], toolFamiliesAuto: [] }
  const visibility = createReaToolVisibility({ readSettings: () => settings })
  assert.equal(visibility.admitted('mcp__rea__inspect_macho'), true)
  assert.equal(visibility.admitted('mcp__rea__inspect_adb_client'), false)
  settings = { ...settings, toolFamilies: [] }
  assert.equal(visibility.admitted('mcp__rea__inspect_adb_client'), true, 'an empty manual list advertises all')
  assert.equal(visibility.admitted('mcp__other__inspect_adb_client'), true, 'foreign tools are untouched')
})

test('auto scope follows the cached plan and a manual edit wins', () => {
  let plan = { families: [...CORE_FAMILIES, 'adb'] }
  let settings = { enabled: true, toolRouting: 'auto', toolFamilies: [], toolFamiliesAuto: [] }
  const visibility = createReaToolVisibility({ readSettings: () => settings, readPlan: () => plan })
  assert.equal(visibility.admitted('mcp__rea__inspect_adb_client'), true)
  assert.equal(visibility.admitted('mcp__rea__list_browser_targets'), false)

  plan = { families: [...CORE_FAMILIES, 'browser'] }
  assert.equal(visibility.admitted('mcp__rea__inspect_adb_client'), false)
  assert.equal(visibility.admitted('mcp__rea__list_browser_targets'), true)

  settings = { ...settings, toolFamilies: ['adb'], toolFamiliesAuto: [] }
  assert.equal(visibility.admitted('mcp__rea__inspect_adb_client'), true)
  assert.equal(visibility.admitted('mcp__rea__list_browser_targets'), false, 'a hand-edited list overrides the plan')
})

test('auto defaults to the core families before the first classification', () => {
  const visibility = createReaToolVisibility({ readSettings: () => ({ enabled: true, toolRouting: 'auto', toolFamilies: [], toolFamiliesAuto: [] }), readPlan: () => null })
  assert.equal(visibility.admitted('mcp__rea__open_binary'), true)
  assert.equal(visibility.admitted('mcp__rea__inspect_adb_client'), false)
})

test('register wraps only REA tools and preserves upstream conditions', async () => {
  const registrations = []
  const ctx = {
    tools: {
      register(definition, options) { registrations.push({ definition, options }); return () => {} },
    },
  }
  const visibility = createReaToolVisibility({ readSettings: () => ({ enabled: true, toolRouting: 'manual', toolFamilies: ['native'], toolFamiliesAuto: [] }) })
  const scoped = visibility.wrapContext(ctx)
  scoped.tools.register({ name: 'mcp__rea__inspect_macho' })
  scoped.tools.register({ name: 'mcp__rea__inspect_adb_client' })
  scoped.tools.register({ name: 'mcp__other__inspect_adb_client' })
  assert.equal(registrations.length, 3)
  assert.equal(await registrations[0].options.when({}), true)
  assert.equal(await registrations[1].options.when({}), false)
  assert.equal(registrations[2].options?.when, undefined, 'non-REA registration is unchanged')

  scoped.tools.register({ name: 'mcp__rea__inspect_macho' }, { when: () => false })
  assert.equal(await registrations[3].options.when({}), false, 'an upstream rejection is preserved')
  assert.equal(await registrations[0].options.when({ signal: { aborted: true } }), false, 'cancellation is observed')
})
