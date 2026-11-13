// Per-step tool visibility.
//
// REA stays connected and every tool stays registered. The `when` condition only
// decides whether a tool is described and callable for the current model step,
// so changing families never restarts the MCP bridge.

import { TOOL_TO_FAMILY } from './tool-family-map.js'
import { CORE_FAMILIES } from './tool-routing.js'

function sameFamilies(left, right) {
  const a = [...(left || [])].sort(), b = [...(right || [])].sort()
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function createReaToolVisibility({ serverName = 'rea', readSettings, readPlan } = {}) {
  const prefix = `mcp__${serverName}__`

  function admitted(publicName) {
    const family = TOOL_TO_FAMILY[publicName.startsWith(prefix) ? publicName.slice(prefix.length) : publicName]
    if (!family) return true
    const settings = readSettings?.() ?? {}
    if (settings.enabled === false) return false
    const selected = Array.isArray(settings.toolFamilies) ? settings.toolFamilies : []
    const automatic = Array.isArray(settings.toolFamiliesAuto) ? settings.toolFamiliesAuto : []

    // Manual mode, or a hand-edited list in auto mode, always wins. Empty means all.
    if (settings.toolRouting !== 'auto' || (selected.length && !sameFamilies(selected, automatic))) {
      return selected.length === 0 || selected.includes(family)
    }

    const plan = readPlan?.()
    const families = Array.isArray(plan) ? plan : Array.isArray(plan?.families) && plan.families.length ? plan.families : CORE_FAMILIES
    return families.includes(family)
  }

  /** Wrap only the tools service; the rest of the Cordis context is inherited. */
  function wrapContext(ctx) {
    // Cordis throws for an uninjected service even on a property read.
    let original
    try { original = ctx?.tools } catch { return ctx }
    if (!original?.register) return ctx
    const scopedTools = Object.create(original)
    scopedTools.register = (definition, options) => {
      const name = definition?.name
      if (typeof name !== 'string' || !name.startsWith(prefix)) return original.register(definition, options)
      const upstream = options?.when
      const when = async step => {
        try {
          if (step?.signal?.aborted) return false
          if (upstream && !(await upstream(step))) return false
          return admitted(name)
        } catch {
          // A visibility failure must not fail step preparation.
          return true
        }
      }
      return original.register(definition, { ...options, when })
    }
    const scoped = Object.create(ctx)
    Object.defineProperty(scoped, 'tools', { value: scopedTools, enumerable: true })
    return scoped
  }

  return { admitted, wrapContext }
}
