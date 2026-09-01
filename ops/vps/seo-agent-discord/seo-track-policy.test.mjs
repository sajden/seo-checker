import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySeoTrack, trackContract } from './seo-track-policy.mjs'

test('classifies GSC query work as ranking', () => {
  assert.equal(classifySeoTrack({ evidenceType: 'gsc', keyword: 'ai konsult stockholm', title: 'Förbättra CTR' }), 'ranking')
  assert.deepEqual(trackContract('ranking').requires, ['primaryQuery', 'targetUrl', 'rankingMetrics', 'hypothesis'])
})

test('keeps indexing and AI visibility separate from ranking', () => {
  assert.equal(classifySeoTrack({ category: 'indexing', title: 'Kontrollera indexering' }), 'indexing')
  assert.equal(classifySeoTrack({ actionType: 'ai_visibility', title: 'AI Search readiness' }), 'ai_visibility')
})
