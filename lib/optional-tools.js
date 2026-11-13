import { createHash } from 'node:crypto'
import { REA_TOOL_NAMES } from './rea-tool-names.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const MAX_ERROR_TEXT = 64 * 1024
const PROVIDERS = new Set(['ghidra', 'hopper', 'kuna', 'ida', 'jeb'])
const HOST_FAILURES = new Set(['unsupported_host', 'unsupported_platform', 'permission_denied', 'access_denied', 'license_required'])

// Mirrors the pinned DSH 0.2.2-rc.1 bridge's published-name derivation. That
// helper is not exported. Exact catalog membership also rejects prefix-adjacent
// servers such as rea__other; no raw-name reverse parsing is used.
export function reaPublicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

function rejectedHost(diagnostics) {
  if (!record(diagnostics)) return false
  if (HOST_FAILURES.has(diagnostics.code) || HOST_FAILURES.has(diagnostics.failure_kind)) return true
  if (diagnostics.system_code === 'EACCES' || diagnostics.system_code === 'EPERM') return true
  return Array.isArray(diagnostics.checks) && diagnostics.checks.slice(0, 32).some(check => record(check) && check.ok !== true && HOST_FAILURES.has(check.code))
}

/** Only reviewed, typed REA 6.9.0 error boundaries can create a hint.
 * Do not search natural-language messages, target strings, captured output,
 * successful provider inventories, or arbitrary nested Evidence for "missing".
 * Unknown or information-losing diagnostics intentionally produce no hint.
 */
export function confirmedMissingDependency(result) {
  if (result?.isError !== true || !record(result.error)) return false
  const message = result.error.message
  if (typeof message !== 'string' || message.length > MAX_ERROR_TEXT) return false
  let envelope
  try { envelope = JSON.parse(message) } catch { return false }
  if (!record(envelope) || !record(envelope.error)) return false
  const error = envelope.error, details = error.details
  if (!record(details) || details.cleanup === 'incomplete') return false
  if (error.code === 'provider_unavailable' && details.selection_reason === 'provider_unavailable' && Array.isArray(details.rejections)) {
    return details.rejections.slice(0, 32).some(rejection => record(rejection) && PROVIDERS.has(rejection.provider_id) && rejection.code === 'not_configured' && !rejectedHost(rejection.diagnostics))
  }
  if (error.code !== 'capability_unavailable') return false
  const diagnostics = details.diagnostics
  if (!record(diagnostics) || rejectedHost(diagnostics)) return false
  // The executable launch boundary distinguishes a missing provider command
  // from a missing target file or a permissions error.
  if (['objdump', 'rizin'].includes(details.provider_id) && diagnostics.boundary === 'provider-launch' && diagnostics.system_code === 'ENOENT') return true
  // JADX's published failure_kind/failure_code identifies an unset JAR, not a
  // wrong version, unsupported platform, missing target, or denied execution.
  return details.provider_id === 'jadx' && diagnostics.failure_kind === 'jar' && diagnostics.failure_code === 'not_configured' && diagnostics.jar_configured === false
}

/** Exact model-facing names owned by this plugin's REA catalog. */
export function reaToolNames(serverName) {
  return new Set(REA_TOOL_NAMES.map(raw => reaPublicToolName(serverName, raw)))
}

/**
 * In-flight REA calls for the composer indicator. Only call identity and the
 * catalog name are retained, never arguments, results or errors. The count is
 * paired per callId so a failed or cancelled body cannot leak a stuck "active".
 */
export function createActivityTracker(serverName) {
  const names = reaToolNames(serverName)
  const active = new Map()
  let lastCompletedAt = 0
  return {
    owns(name) { return names.has(name) },
    begin(exec) {
      const id = exec?.callId, name = exec?.name
      if (typeof id !== 'string' || id.length > 200 || !names.has(name)) return false
      active.set(id, name)
      return true
    },
    end(exec) {
      const id = exec?.callId
      if (typeof id !== 'string' || !active.has(id)) return false
      active.delete(id)
      lastCompletedAt = Date.now()
      return true
    },
    snapshot() {
      const tools = [...new Set(active.values())].slice(0, 3)
      return { inflight: active.size, tools, lastCompletedAt }
    },
    clear() { active.clear(); lastCompletedAt = 0 },
  }
}

/** Memory-only state: retain tool identities, never args, paths, errors or results. */
export function createDependencyTracker(serverName) {
  const names = new Set(REA_TOOL_NAMES.map(raw => reaPublicToolName(serverName, raw)))
  const missing = new Set()
  return {
    observe(exec, result) {
      if (!names.has(exec?.name)) return
      if (result?.isError === false) missing.delete(exec.name)
      else if (confirmedMissingDependency(result)) missing.add(exec.name)
    },
    snapshot() { return { missingDependency: missing.size > 0 } },
    clear() { missing.clear() },
  }
}
