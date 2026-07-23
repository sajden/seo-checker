import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOpportunityEvidenceContext, validateOpportunityEvidence } from './opportunity-evidence.mjs'

const batch = {
  lastRunAt: '2026-07-23T07:11:47.757Z',
  lastRunDetails: {
    gscRows: [
      {
        keys: ['https://sebcastwall.se/tjanster/webbutveckling', 'webbutveckling stockholm'],
        clicks: 1,
        impressions: 42,
        ctr: 1 / 42,
        position: 12.4
      }
    ],
    crawlPages: [
      {
        url: 'https://sebcastwall.se/tjanster/webbutveckling',
        status: 200,
        title: '',
        metaDescription: 'Beskrivning',
        canonical: 'https://sebcastwall.se/tjanster/webbutveckling',
        h1Count: 1
      }
    ]
  }
}

test('builds a compact evidence context', () => {
  const context = buildOpportunityEvidenceContext(batch)
  assert.equal(context.runAt, batch.lastRunAt)
  assert.equal(context.gscRows.length, 1)
  assert.deepEqual(context.crawlSignals[0].issues, ['missing_title'])
})

test('verifies GSC evidence against URL and query', () => {
  const context = buildOpportunityEvidenceContext(batch)
  const result = validateOpportunityEvidence({
    evidenceType: 'gsc',
    targetUrl: 'https://sebcastwall.se/tjanster/webbutveckling/',
    keyword: 'webbutveckling stockholm'
  }, context)
  assert.equal(result.ok, true)
  assert.equal(result.evidence.impressions, 42)
})

test('rejects an invented GSC claim', () => {
  const context = buildOpportunityEvidenceContext(batch)
  const result = validateOpportunityEvidence({
    evidenceType: 'gsc',
    targetUrl: 'https://sebcastwall.se/tjanster/ai-agenter',
    keyword: 'ai agent stockholm'
  }, context)
  assert.deepEqual(result, { ok: false, reason: 'gsc_evidence_not_verified' })
})

test('verifies a crawl defect on the same URL', () => {
  const context = buildOpportunityEvidenceContext(batch)
  const result = validateOpportunityEvidence({
    evidenceType: 'crawl',
    targetUrl: 'https://sebcastwall.se/tjanster/webbutveckling',
    keyword: 'teknisk seo'
  }, context)
  assert.equal(result.ok, true)
  assert.deepEqual(result.evidence.issues, ['missing_title'])
})
