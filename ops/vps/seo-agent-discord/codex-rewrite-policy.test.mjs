import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCodexBriefRewrite } from './codex-rewrite-policy.mjs'

test('applies the final target URL from a Codex rewrite', () => {
  const result = applyCodexBriefRewrite({
    id: 'action-1',
    targetUrl: 'https://example.com/wrong'
  }, {
    decision: 'rewrite',
    targetUrl: 'https://example.com/right',
    title: 'Correct target',
    doThis: 'Update the correct page.'
  }, 'example.com')
  assert.equal(result.targetUrl, 'https://example.com/right')
  assert.equal(result.originalTargetUrl, 'https://example.com/wrong')
  assert.equal(result.codexRewriteApplied, true)
})

test('rejects a rewrite that changes domain', () => {
  assert.equal(applyCodexBriefRewrite({ targetUrl: 'https://example.com/a' }, {
    decision: 'rewrite',
    targetUrl: 'https://other.example/a'
  }, 'example.com'), null)
})

test('rejects a rewrite without a valid HTTPS target', () => {
  assert.equal(applyCodexBriefRewrite({}, { decision: 'rewrite', targetUrl: '/relative' }, 'example.com'), null)
})
