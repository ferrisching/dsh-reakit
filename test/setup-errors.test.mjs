import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySetupFailure, describeSetupFailure } from '../lib/setup-errors.js'

test('a full disk is reported as disk, with the root to free up', () => {
  const result = classifySetupFailure(Object.assign(new Error('write failed'), { code: 'ENOSPC' }), { root: '/data/dsh' })
  assert.equal(result.kind, 'disk')
  assert.match(result.message, /disk space/i)
  assert.match(result.message, /\/data\/dsh/)
})

test('permission problems name the directory and the fix', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    const result = classifySetupFailure(Object.assign(new Error('denied'), { code }), { root: '/data/dsh' })
    assert.equal(result.kind, 'permission', code)
    assert.match(result.message, /writable by your user/)
  }
  assert.equal(classifySetupFailure(new Error('npm ERR! EACCES: permission denied, mkdir')).kind, 'permission')
})

test('network failures cover dns, timeouts, refusals, tls and http status', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH']) {
    assert.equal(classifySetupFailure(Object.assign(new Error('x'), { code })).kind, 'network', code)
  }
  assert.equal(classifySetupFailure(new Error('fetch failed')).kind, 'network')
  assert.equal(classifySetupFailure(new Error('HTTP 503 from nodejs.org')).kind, 'network')
  assert.equal(classifySetupFailure(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).kind, 'network')
})

test('npm stderr is inspected when the exit code is generic', () => {
  const error = Object.assign(new Error('Command failed: npm ci'), { code: 1, stderr: 'npm ERR! ENOSPC: no space left on device' })
  assert.equal(classifySetupFailure(error).kind, 'disk')
  const dns = Object.assign(new Error('Command failed: npm ci'), { code: 1, stderr: 'npm ERR! request to https://registry.npmjs.org/rea-agents failed, reason: getaddrinfo ENOTFOUND' })
  assert.equal(classifySetupFailure(dns).kind, 'network')
})

test('unknown failures keep their original message instead of a generic one', () => {
  const result = classifySetupFailure(new Error('REA dependency lock checksum mismatch'))
  assert.equal(result.kind, 'other')
  assert.equal(result.message, 'REA dependency lock checksum mismatch')
  assert.equal(describeSetupFailure(new Error('boom')), 'boom')
})
