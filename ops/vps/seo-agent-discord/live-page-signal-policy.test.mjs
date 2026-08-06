import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimedMissingSignals,
  extractLivePageSignals,
  keywordAlreadyCovered,
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

test('recognizes a keyword inside compounds and ignores Swedish stop words', () => {
  assert.equal(keywordAlreadyCovered('garage Göteborg', {
    title: 'Garageparkering i Göteborg',
    h1: 'Garage och parkeringsgarage i Göteborg'
  }), true)
  assert.equal(keywordAlreadyCovered('MC parkering Jönköping', {
    title: 'MC-parkering i Jönköping'
  }), true)
})

test('blocks exact-keyword work when the live page already covers the intent', async () => {
  const result = await validateActionAgainstLivePage(
    {
      targetUrl: 'https://example.com/sv/garage-parkering-goteborg',
      keyword: 'garage Göteborg',
      title: 'Täck keyword: garage Göteborg',
      why: 'Keyword hittades inte i title/H1/H2/meta.'
    },
    async () => new Response(
      '<title>Garageparkering i Göteborg</title><meta name="description" content="Hitta garage och parkering i Göteborg"><h1>Garage och parkeringsgarage i Göteborg</h1>',
      { status: 200 }
    )
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'live_page_already_covers_keyword_semantically')
})

test('blocks a CTR brief that mistakes a hyphen for missing query coverage', async () => {
  const result = await validateActionAgainstLivePage(
    {
      targetUrl: 'https://example.com/sv/mc-parkering-jonkoping',
      keyword: 'mc parkering jönköping',
      title: 'Förbättra CTR för MC-parkering Jönköping',
      why: 'Title/meta använder främst bindestrecksformen MC-parkering och saknar exakt queryform.'
    },
    async () => new Response(
      '<title>MC-parkering i Jönköping | karta och villkor</title><meta name="description" content="Se MC-parkering i Jönköping på karta"><h1>MC-parkering i Jönköping</h1>',
      { status: 200 }
    )
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'live_page_already_covers_keyword_semantically')
})

test('allows exact-keyword work when important keyword terms are absent', async () => {
  const result = await validateActionAgainstLivePage(
    {
      targetUrl: 'https://example.com/automation',
      keyword: 'schemaläggning med AI',
      title: 'Täck keyword: schemaläggning med AI'
    },
    async () => new Response(
      '<title>AI-automatisering för företag</title><meta name="description" content="Automatisera arbetet"><h1>AI-automatisering</h1>',
      { status: 200 }
    )
  )
  assert.equal(result.ok, true)
})
