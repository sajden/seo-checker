import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRankingOpportunities, rankingHypothesisForOpportunity } from './ranking-engine.mjs'

test('prioritizes page-one CTR opportunities above weak low-visibility ideas', () => {
  const result = buildRankingOpportunities({
    rows: [
      { page: 'https://example.com/service', query: 'service stockholm', impressions: 200, clicks: 2, ctr: 0.01, position: 6.2 },
      { page: 'https://example.com/blog', query: 'unrelated long tail', impressions: 12, clicks: 0, ctr: 0, position: 28.4 },
      { page: 'https://example.com/noise', query: 'too low', impressions: 500, clicks: 0, ctr: 0, position: 45 }
    ],
    minImpressions: 10
  })
  assert.equal(result.length, 2)
  assert.equal(result[0].query, 'service stockholm')
  assert.equal(result[0].actionType, 'ranking_ctr')
})

test('deduplicates rows and creates an explicit ranking hypothesis', () => {
  const result = buildRankingOpportunities({
    rows: [
      { page: 'https://example.com/a/', query: 'test fråga', impressions: 20, ctr: 0, position: 18 },
      { page: 'https://example.com/a', query: 'test fråga', impressions: 40, ctr: 0, position: 16 }
    ]
  })
  assert.equal(result.length, 1)
  const hypothesis = rankingHypothesisForOpportunity(result[0])
  assert.equal(hypothesis.targetUrl, 'https://example.com/a')
  assert.deepEqual(hypothesis.fields, ['title', 'h1', 'intro', 'h2', 'faq', 'internal_links'])
})

test('rejects ranking opportunities without query, URL, impressions or usable position', () => {
  const result = buildRankingOpportunities({
    rows: [
      { page: 'https://example.com/a', query: '', impressions: 100, position: 10 },
      { page: '', query: 'test', impressions: 100, position: 10 },
      { page: 'https://example.com/c', query: 'test', impressions: 0, position: 10 },
      { page: 'https://example.com/d', query: 'test', impressions: 100, position: 0 }
    ]
  })
  assert.deepEqual(result, [])
})
