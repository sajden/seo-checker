import assert from 'node:assert/strict'
import test from 'node:test'
import { exactTargetFromRecords, normalizeExactUrl, validateExactInspection } from './gsc-exact-url-policy.mjs'

const target = 'https://sebcastwall.se/tjanster/mobilappar/interna-faltappar'

test('normalizes harmless URL variants without collapsing the path', () => {
  assert.equal(normalizeExactUrl(`${target}/#intro`), target)
  assert.equal(normalizeExactUrl('https://www.sebcastwall.se/'), 'https://sebcastwall.se/')
})

test('uses persisted action target instead of a workspace root fallback', () => {
  assert.equal(exactTargetFromRecords({ posted: { targetUrl: target }, active: { targetUrl: 'https://sebcastwall.se/' } }), target)
})

test('root inspection cannot close a nested page action', () => {
  const verdict = validateExactInspection({ expectedUrl: target, result: { targetUrl: 'https://sebcastwall.se/', inspection: { status: 'indexed', confidence: 0.95 } } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.indexed, false)
  assert.equal(verdict.reason, 'inspection_target_mismatch')
})

test('exact indexed target can close the action', () => {
  const verdict = validateExactInspection({ expectedUrl: target, result: { targetUrl: `${target}/`, inspection: { status: 'indexed', confidence: 0.95, googleCanonical: target } } })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.indexed, true)
})

test('different Google canonical keeps the action open', () => {
  const verdict = validateExactInspection({ expectedUrl: target, result: { targetUrl: target, inspection: { status: 'indexed', confidence: 0.95, googleCanonical: 'https://sebcastwall.se/' } } })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.indexed, false)
  assert.equal(verdict.reason, 'google_canonical_differs')
})
