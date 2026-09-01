import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSeoDiff } from './seo-diff-policy.mjs'

test('accepts a ranking diff with query terms and SEO surface', () => {
  const result = validateSeoDiff({
    action: { actionType: 'ranking_ctr', keyword: 'microsoft 365 konsult stockholm', evidenceType: 'gsc' },
    changedFiles: ['app/tjanster/microsoft-365/page.tsx'],
    diff: '+ title: "Microsoft 365 konsult i Stockholm för företag"\n+ <h1>Microsoft 365 konsult i Stockholm</h1>'
  })
  assert.equal(result.ok, true)
})

test('rejects a ranking diff that only changes an unrelated link', () => {
  const result = validateSeoDiff({
    action: { actionType: 'ranking_relevance', keyword: 'microsoft 365 konsult stockholm', evidenceType: 'gsc' },
    changedFiles: ['app/foretag/page.tsx'],
    diff: '+ <a href="/tjanster/ai-automatisering">AI-automatisering</a>'
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ranking_diff_does_not_reflect_primary_query')
})

test('rejects a ranking diff that only mentions the query in keyword metadata', () => {
  const result = validateSeoDiff({
    action: { actionType: 'ranking_relevance', keyword: 'visma eekonomi integration', evidenceType: 'gsc' },
    changedFiles: ['content/integrations/visma-eekonomi-integration.mdx'],
    diff: '+ keyword: "visma eekonomi integration"\n+ title: "Koppla Visma eEkonomi via API"\n+ description: "Koppla Visma eEkonomi till CRM via API."'
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ranking_diff_query_not_in_seo_surface')
})

test('does not apply ranking requirements to technical actions', () => {
  const result = validateSeoDiff({
    action: { actionType: 'technical', category: 'technical' },
    changedFiles: ['app/qr/page.tsx'],
    diff: '+ alternates: { canonical: "/qr" }'
  })
  assert.equal(result.ok, true)
})
