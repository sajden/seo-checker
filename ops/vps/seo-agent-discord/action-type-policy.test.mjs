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
