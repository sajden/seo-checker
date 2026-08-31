import assert from 'node:assert/strict'
import test from 'node:test'
import { isIndexingActionIdentity } from './action-type-policy.mjs'

test('GSC indexing identity survives a Codex title rewrite', () => {
  assert.equal(isIndexingActionIdentity({
    id: 'gsc_issue_sebcastwall_gsc-indexing-issue_tjanster-mobilappar-interna-faltappar',
    title: 'Verifiera sidan tekniskt',
    category: 'technical'
  }), true)
})

test('ordinary content action remains a code action', () => {
  assert.equal(isIndexingActionIdentity({
    id: 'seo_action_webbutveckling_stockholm',
    title: 'Förbättra metadata för webbutveckling',
    category: 'content'
  }), false)
})

test('GSC query content work is not misclassified as an indexing check', () => {
  assert.equal(isIndexingActionIdentity({
    id: 'seo_action_gsc_query_ctr',
    title: 'Förbättra CTR: webbutveckling företag',
    category: 'indexing',
    action: 'Uppdatera title och meta för queryn.'
  }), false)
})

test('GSC indexing issue label does not suppress a verified content action', () => {
  assert.equal(isIndexingActionIdentity({
    id: 'seo_action_gsc_query_title',
    title: 'Lyft GSC-query: microsoft 365 konsult',
    category: 'indexing',
    issueType: 'gsc-indexing-issue',
    recommendedAction: 'Förbättra title och meta för den observerade queryn.'
  }), false)
})
