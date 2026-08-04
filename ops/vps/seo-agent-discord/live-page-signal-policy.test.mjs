import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimedMissingSignals,
  extractLivePageSignals,
  validateActionAgainstLivePage
} from './live-page-signal-policy.mjs'

test('detects missing-signal claims in a generated SEO brief', () => {
  assert.deepEqual(claimedMissingSignals({
    recommendedAction: '## Current signals\nTitle: saknas\nH1: saknas\nMeta: saknas'
  }), { title: true, h1: true, metaDescription: true })
})

test('extracts title, H1 and description regardless of meta attribute order', () => {
  assert.deepEqual(extractLivePageSignals(`
    <html><head>
      <title>Microsoft 365 konsult | Seb</title>
      <meta content="Praktisk Microsoft 365-hjalp" name="description">
    </head><body><h1>Fa ordning pa Microsoft 365</h1></body></html>
  `), {
    title: 'Microsoft 365 konsult | Seb',
    h1: 'Fa ordning pa Microsoft 365',
    metaDescription: 'Praktisk Microsoft 365-hjalp'
  })
})

test('blocks a stale brief when the live page contains the allegedly missing signals', async () => {
  const result = await validateActionAgainstLivePage(
    {
      targetUrl: 'https://example.com/page',
      recommendedAction: 'Title: saknas\nH1: saknas\nMeta: saknas'
    },
    async () => new Response(
      '<title>Finns</title><meta name="description" content="Finns ocksa"><h1>Rubrik finns</h1>',
      { status: 200 }
    )
  )
  assert.equal(result.ok, false)
  assert.match(result.reason, /live_page_contradicts_missing_signals/)
  assert.deepEqual(result.contradicted, ['title', 'h1', 'metaDescription'])
})

test('does not fetch for actions that make no missing-signal claim', async () => {
  let fetched = false
  const result = await validateActionAgainstLivePage(
    { targetUrl: 'https://example.com', recommendedAction: 'Forbattra en internlank.' },
    async () => { fetched = true; throw new Error('should not fetch') }
  )
  assert.equal(result.ok, true)
  assert.equal(result.checked, false)
  assert.equal(fetched, false)
})
