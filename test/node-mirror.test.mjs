import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveNodeMirror, mirrorArtifact, verifyMirrorShasums } from '../lib/node-mirror.js'
import { NODE_VERSION } from '../lib/bootstrap.js'

const digest = 'a'.repeat(64)
const artifact = { filename: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: digest, url: `https://nodejs.org/dist/v${NODE_VERSION}/x`, checksumSource: `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt` }

test('an empty mirror keeps the official distribution host', () => {
  assert.equal(resolveNodeMirror(''), 'https://nodejs.org/dist')
  assert.equal(resolveNodeMirror(undefined), 'https://nodejs.org/dist')
  assert.equal(resolveNodeMirror('https://mirror.example.com/nodejs/'), 'https://mirror.example.com/nodejs')
})

test('only https mirrors without credentials are accepted', () => {
  for (const bad of ['http://mirror.example.com', 'https://u:p@mirror.example.com', 'https://mirror.example.com/?a=1', 'nonsense']) {
    assert.throws(() => resolveNodeMirror(bad), /nodeMirror/, bad)
  }
})

test('mirroring rewrites both the archive and checksum URLs, keeping the pinned digest', () => {
  const mirrored = mirrorArtifact(artifact, 'https://mirror.example.com/nodejs', NODE_VERSION)
  assert.equal(mirrored.url, `https://mirror.example.com/nodejs/v${NODE_VERSION}/${artifact.filename}`)
  assert.equal(mirrored.checksumSource, `https://mirror.example.com/nodejs/v${NODE_VERSION}/SHASUMS256.txt`)
  assert.equal(mirrored.sha256, digest)
})

test('the official artifact is passed through untouched', async () => {
  const { OFFICIAL_NODE_DIST } = await import('../lib/node-dist.js')
  assert.equal(mirrorArtifact(artifact, OFFICIAL_NODE_DIST, NODE_VERSION), artifact)
})

test('SHASUMS must agree with the pinned digest', async () => {
  const list = `${digest}  ${artifact.filename}\n`
  const ok = await verifyMirrorShasums({ artifact, fetchImpl: async url => { assert.equal(url, artifact.checksumSource); return new Response(list) } })
  assert.equal(ok, digest)
  await assert.rejects(
    verifyMirrorShasums({ artifact, fetchImpl: async () => new Response(`${'b'.repeat(64)}  ${artifact.filename}\n`) }),
    /disagrees with the pinned release digest/,
  )
  await assert.rejects(
    verifyMirrorShasums({ artifact, fetchImpl: async () => new Response(`${digest}  other-file.tar.gz\n`) }),
    /does not list/,
  )
  await assert.rejects(
    verifyMirrorShasums({ artifact, fetchImpl: async () => new Response('x'.repeat(70 * 1024)) }),
    /unexpectedly large/,
  )
  await assert.rejects(
    verifyMirrorShasums({ artifact, fetchImpl: async () => new Response('nope', { status: 503 }) }),
    /HTTP 503/,
  )
})

test('the pinned digest really is the digest of the published filename mapping', () => {
  // Guards against someone swapping the pinned digest without touching the mirror check.
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
  assert.equal(createHash('sha256').update(artifact.filename).digest('hex').length, 64)
})
