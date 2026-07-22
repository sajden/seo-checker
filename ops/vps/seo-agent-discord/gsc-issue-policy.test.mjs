import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyGscIssue, groupGscReviewCandidates, isExpiredEventUrl } from './gsc-issue-policy.mjs'

const now = new Date('2026-07-22T16:00:00Z')

test('resolved redirects never become review cards', () => {
  const result = classifyGscIssue({
    issue: { type: 'gsc-indexing-issue', affectedUrl: 'https://example.com/old', reason: 'canonical differs' },
    evidence: { httpStatus: 308, redirected: true, finalUrl: 'https://example.com/new', finalStatus: 200 },
    now
  })
  assert.equal(result.disposition, 'resolved')
})

test('redirect to broken destination requires review', () => {
  const result = classifyGscIssue({
    issue: { type: 'gsc-indexing-issue', affectedUrl: 'https://example.com/old', reason: 'canonical differs' },
    evidence: { httpStatus: 308, redirected: true, finalUrl: 'https://example.com/missing', finalStatus: 404 },
    now
  })
  assert.equal(result.disposition, 'review')
  assert.equal(result.score, 95)
})

test('expired event 404 outside sitemap is monitored without operator review', () => {
  const url = 'https://example.com/stockholm/evenemang/demo-2026-06-01-stockholm'
  assert.equal(isExpiredEventUrl(url, now), true)
  const result = classifyGscIssue({
    issue: { type: 'not_found_404', affectedUrl: url },
    evidence: { httpStatus: 404, inSitemap: false },
    now
  })
  assert.equal(result.disposition, 'monitor')
})

test('404 URL still present in sitemap is high-priority review work', () => {
  const result = classifyGscIssue({
    issue: { type: 'not_found_404', affectedUrl: 'https://example.com/broken' },
    evidence: { httpStatus: 404, inSitemap: true },
    now
  })
  assert.equal(result.disposition, 'review')
  assert.equal(result.score, 95)
})

test('recent event 404 is not silently treated as expired', () => {
  const result = classifyGscIssue({
    issue: { type: 'not_found_404', affectedUrl: 'https://example.com/evenemang/demo-2026-07-20-stockholm' },
    evidence: { httpStatus: 404, inSitemap: false },
    now
  })
  assert.equal(result.disposition, 'review')
})

test('canonical mismatch without redirect remains a high-priority review', () => {
  const result = classifyGscIssue({
    issue: { type: 'duplicate_google_chose_different_canonical', affectedUrl: 'https://example.com/page', reason: 'Google chose another canonical' },
    evidence: { httpStatus: 200, redirected: false, inSitemap: true },
    now
  })
  assert.equal(result.disposition, 'review')
  assert.equal(result.score, 85)
})

test('live sitemap page with discovery issue is inspected before review', () => {
  const result = classifyGscIssue({
    issue: { type: 'gsc-indexing-issue', affectedUrl: 'https://example.com/service', reason: 'Google känner inte till URL:en ännu.' },
    evidence: { httpStatus: 200, inSitemap: true },
    now
  })
  assert.equal(result.disposition, 'inspect')
})

test('multiple unresolved 404s collapse into one prioritized batch', () => {
  const candidates = groupGscReviewCandidates([
    { issue: { type: 'not_found_404', affectedUrl: 'https://example.com/a' }, score: 65 },
    { issue: { type: 'not_found_404', affectedUrl: 'https://example.com/b' }, score: 95 },
    { issue: { type: 'excluded_by_noindex', affectedUrl: 'https://example.com/c' }, score: 100 }
  ])
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].issue.type, 'excluded_by_noindex')
  assert.equal(candidates[1].batch, true)
  assert.equal(candidates[1].issues.length, 2)
})
