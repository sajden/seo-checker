import assert from 'node:assert/strict'
import test from 'node:test'
import { checkActionEvidenceIntegrity } from './action-evidence-policy.mjs'

const now = Date.parse('2026-08-06T12:00:00Z')

test('rejects a GSC claim backed only by workspace backlog', () => {
  const result = checkActionEvidenceIntegrity({
    why: 'GSC visar 51 impressions och 0 klick.',
    evidenceSource: 'workspace_goal_backlog'
  }, { now })
  assert.deepEqual(result, { ok: false, reason: 'gsc_claim_without_gsc_provenance' })
})

test('accepts a fresh verified GSC observation', () => {
  const result = checkActionEvidenceIntegrity({
    why: 'GSC visar ett CTR-problem.',
    evidenceSource: 'fresh_gsc_plus_codex_repo_scout',
    evidenceRunAt: '2026-08-06T04:00:00Z',
    verifiedEvidence: { type: 'gsc', runAt: '2026-08-06T04:00:00Z' }
  }, { now })
  assert.deepEqual(result, { ok: true, reason: 'evidence_integrity_ok' })
})

test('rejects evidence advertised as fresh after its freshness window', () => {
  const result = checkActionEvidenceIntegrity({
    evidenceSource: 'fresh_keyword_planner_plus_codex_repo_scout',
    evidenceRunAt: '2026-08-01T04:00:00Z',
    verifiedEvidence: { type: 'keyword_planner', runAt: '2026-08-01T04:00:00Z' }
  }, { now })
  assert.deepEqual(result, { ok: false, reason: 'fresh_evidence_is_stale' })
})
