// Optional Node.js distribution mirror.
//
// Corporate networks often proxy nodejs.org. A mirror only changes where the
// archive comes from: the pinned SHA-256 in source still verifies the bytes, and
// the mirror's own SHASUMS256.txt is checked against that pinned digest, so a
// mirror serving different content fails closed.
import { OFFICIAL_NODE_DIST } from './node-dist.js'

const MAX_SHASUMS_BYTES = 64 * 1024

/** Only an https base URL without credentials is accepted. */
export function resolveNodeMirror(value) {
  if (value === undefined || value === null || value === '') return OFFICIAL_NODE_DIST
  let url
  try { url = new URL(String(value)) } catch { throw new Error('nodeMirror must be an absolute https URL') }
  if (url.protocol !== 'https:') throw new Error('nodeMirror must use https')
  if (url.username || url.password) throw new Error('nodeMirror must not embed credentials')
  if (url.search || url.hash) throw new Error('nodeMirror must not carry a query or fragment')
  return url.toString().replace(/\/+$/, '')
}

/** Point one artifact at the mirror, keeping its pinned digest and filename. */
export function mirrorArtifact(artifact, base, version) {
  if (base === OFFICIAL_NODE_DIST) return artifact
  return {
    ...artifact,
    url: `${base}/v${version}/${artifact.filename}`,
    checksumSource: `${base}/v${version}/SHASUMS256.txt`,
  }
}

function parseShasums(text, filename) {
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (match && match[2].trim() === filename) return match[1].toLowerCase()
  }
  return null
}

/**
 * Fetch the mirror's checksum list and require it to agree with the pinned digest.
 * Runs after the archive download, before any extraction.
 */
export async function verifyMirrorShasums({ artifact, fetchImpl = globalThis.fetch, signal }) {
  if (!artifact.checksumSource) throw new Error('Node checksum source is unknown')
  const response = await fetchImpl(artifact.checksumSource, { signal, redirect: 'error' })
  if (!response?.ok) throw new Error(`Node checksum list unavailable: HTTP ${response?.status}`)
  const text = await response.text()
  if (text.length > MAX_SHASUMS_BYTES) throw new Error('Node checksum list is unexpectedly large')
  const digest = parseShasums(text, artifact.filename)
  if (digest === null) throw new Error(`Node checksum list does not list ${artifact.filename}`)
  if (digest !== artifact.sha256) throw new Error('Node checksum list disagrees with the pinned release digest')
  return digest
}
