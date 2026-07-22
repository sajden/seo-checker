import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGscExperimentSnapshot, evaluateExperimentMeasurement, nextExperimentPhase } from './seo-experiment-measurement.mjs'

const batch = (ranAt, rows, rawRows = rows.length) => ({
  lastRunAt: ranAt,
  lastRunSummary: { ranAt, gscRawRows: rawRows },
  lastRunDetails: { gscRows: rows }
})

test('builds exact page and query metrics from a complete GSC batch', () => {
  const snapshot = buildGscExperimentSnapshot({
    batch: batch('2026-07-01T10:00:00Z', [
      { keys: ['https://example.com/service/', 'ai konsult'], clicks: 2, impressions: 20, ctr: 0.1, position: 8 },
      { keys: ['https://example.com/service', 'annan fråga'], clicks: 1, impressions: 10, ctr: 0.1, position: 12 }
    ]),
    targetUrl: 'https://www.example.com/service',
    keyword: 'AI konsult'
  })
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.page.clicks, 3)
  assert.equal(snapshot.page.impressions, 30)
  assert.equal(snapshot.query.clicks, 2)
  assert.equal(snapshot.query.position, 8)
})

test('does not treat an absent target as zero when GSC rows are truncated', () => {
  const snapshot = buildGscExperimentSnapshot({
    batch: batch('2026-07-01T10:00:00Z', [], 500),
    targetUrl: 'https://example.com/missing',
    keyword: 'missing'
  })
  assert.equal(snapshot.coverage, 'truncated')
  assert.equal(snapshot.status, 'unavailable')
  assert.equal(snapshot.page.available, false)
})

test('classifies a supported query improvement', () => {
  const baseline = buildGscExperimentSnapshot({
    batch: batch('2026-07-01T10:00:00Z', [{ keys: ['https://example.com/service', 'ai konsult'], clicks: 1, impressions: 50, ctr: 0.02, position: 12 }]),
    targetUrl: 'https://example.com/service', keyword: 'ai konsult'
  })
  const followup = buildGscExperimentSnapshot({
    batch: batch('2026-07-15T10:00:00Z', [{ keys: ['https://example.com/service', 'ai konsult'], clicks: 5, impressions: 80, ctr: 0.0625, position: 7 }]),
    targetUrl: 'https://example.com/service', keyword: 'ai konsult'
  })
  const result = evaluateExperimentMeasurement({ baseline, followup, phase: 'day14' })
  assert.equal(result.outcome, 'improved')
  assert.equal(result.scope, 'query')
  assert.equal(result.confidence, 'medium')
  assert.ok(result.positiveSignals.includes('clicks'))
  assert.ok(result.positiveSignals.includes('position'))
})

test('keeps sparse data inconclusive instead of inventing a positive result', () => {
  const baseline = buildGscExperimentSnapshot({ batch: batch('2026-07-01T10:00:00Z', []), targetUrl: 'https://example.com/service' })
  const followup = buildGscExperimentSnapshot({ batch: batch('2026-07-15T10:00:00Z', []), targetUrl: 'https://example.com/service' })
  const result = evaluateExperimentMeasurement({ baseline, followup })
  assert.equal(result.outcome, 'insufficient_data')
  assert.equal(result.confidence, 'low')
})

test('falls back to page metrics when the exact query is too sparse', () => {
  const baseline = buildGscExperimentSnapshot({
    batch: batch('2026-07-01T10:00:00Z', [
      { keys: ['https://example.com/service', 'ai konsult'], clicks: 0, impressions: 2, ctr: 0, position: 30 },
      { keys: ['https://example.com/service', 'annan fråga'], clicks: 1, impressions: 48, ctr: 0.02, position: 15 }
    ]),
    targetUrl: 'https://example.com/service', keyword: 'ai konsult'
  })
  const followup = buildGscExperimentSnapshot({
    batch: batch('2026-07-15T10:00:00Z', [
      { keys: ['https://example.com/service', 'ai konsult'], clicks: 0, impressions: 3, ctr: 0, position: 28 },
      { keys: ['https://example.com/service', 'annan fråga'], clicks: 4, impressions: 77, ctr: 0.05, position: 9 }
    ]),
    targetUrl: 'https://example.com/service', keyword: 'ai konsult'
  })
  const result = evaluateExperimentMeasurement({ baseline, followup })
  assert.equal(result.scope, 'page')
  assert.equal(result.outcome, 'improved')
})

test('schedules both day 14 and day 30 measurements', () => {
  const now = new Date('2026-07-31T00:00:00Z')
  const experiment = { completedAt: '2026-07-01T00:00:00Z', measurements: { followups: {} } }
  assert.equal(nextExperimentPhase(experiment, now), 'day14')
  experiment.measurements.followups.day14 = { capturedAt: now.toISOString() }
  assert.equal(nextExperimentPhase(experiment, now), 'day30')
})
