// Turn low-level setup failures into one actionable sentence.
//
// The three causes users actually hit are a blocked network, a full disk and a
// directory they cannot write. Everything else keeps its original wording so
// diagnosis is never hidden behind a generic message.
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
])

const text = value => (typeof value === 'string' ? value : '')

export function classifySetupFailure(error, { root } = {}) {
  const code = text(error?.code) || text(error?.errno)
  const haystack = [code, text(error?.message), text(error?.stderr), text(error?.stdout), text(error?.cause?.message)].join(' ')
  if (/ENOSPC|no space left on device/i.test(haystack)) {
    return { kind: 'disk', message: `Not enough disk space while preparing REA${root ? ` under ${root}` : ''}. Free up space and retry the setup.` }
  }
  if (/EACCES|EPERM|EROFS|operation not permitted|permission denied|read-only file system/i.test(haystack)) {
    return { kind: 'permission', message: `Permission denied while preparing REA${root ? ` under ${root}` : ''}. Make sure that directory is writable by your user, then retry.` }
  }
  const networkish = NETWORK_CODES.has(code)
    || /fetch failed|getaddrinfo|socket hang up|self.signed certificate|certificate has expired|EAI_AGAIN/i.test(haystack)
    || /HTTP\s+(4\d\d|5\d\d)/i.test(haystack)
  if (networkish) {
    return { kind: 'network', message: `Network error while preparing REA. Check the connection or proxy settings, then retry the setup.` }
  }
  return { kind: 'other', message: error?.message ? String(error.message) : 'REA setup failed' }
}

/** One-line summary for logs and the status message. */
export function describeSetupFailure(error, options) {
  return classifySetupFailure(error, options).message
}
