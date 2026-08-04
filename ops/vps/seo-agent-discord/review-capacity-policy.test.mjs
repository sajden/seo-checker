import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewCapacityCheck } from './review-capacity-policy.mjs'

const workspace = { repoFullName: 'sajden/example' }

test('allows another review until the configured workspace limit is reached', () => {
  const state = { codeActionResults: {
    first: { status: 'review_ready', result: { repoFullName: 'sajden/example', reviewContext: { targetUrl: 'https://example.com/a' } } }
  } }
  assert.equal(reviewCapacityCheck({ state, workspace, action: { targetUrl: 'https://example.com/b' }, maxPendingReviews: 3 }).ok, true)
})

test('blocks a second review for the same target URL', () => {
  const state = { codeActionResults: {
    first: { status: 'review_ready', result: { repoFullName: 'sajden/example', reviewContext: { targetUrl: 'https://example.com/a/' } } }
  } }
  const result = reviewCapacityCheck({ state, workspace, action: { targetUrl: 'https://example.com/a' }, maxPendingReviews: 3 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'target_review_pending')
})

test('blocks new reviews only when the configured workspace limit is full', () => {
  const results = Object.fromEntries([1, 2, 3].map((index) => [String(index), {
    status: 'review_ready',
    result: { repoFullName: 'sajden/example', reviewContext: { targetUrl: `https://example.com/${index}` } }
  }]))
  const result = reviewCapacityCheck({ state: { codeActionResults: results }, workspace, action: { targetUrl: 'https://example.com/new' }, maxPendingReviews: 3 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'workspace_review_limit')
})
