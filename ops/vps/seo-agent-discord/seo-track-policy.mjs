export function classifySeoTrack(action = {}) {
  const explicit = String(action.track || action.actionType || '').toLowerCase()
  if (/index|gsc/.test(explicit) || /indexering|url inspection|sitemap|robots|canonical/.test(actionText(action))) return 'indexing'
  if (/technical|technical_seo|crawl/.test(explicit) || /technical|crawl|metadatafel|missing title|missing meta|canonical/.test(actionText(action))) return 'technical'
  if (/ai|visibility|readiness/.test(explicit) || /ai search|ai visibility|ai-readiness/.test(actionText(action))) return 'ai_visibility'
  if (/internal.?links?|internl[aä]nk/.test(explicit) || /internl[aä]nk|internal link/.test(actionText(action))) return 'internal_links'
  if (action.keyword || action.primaryQuery || /^ranking_/.test(explicit) || String(action.evidenceType || '').toLowerCase() === 'gsc') return 'ranking'
  return 'unclassified'
}

export function trackContract(track) {
  const contracts = {
    ranking: {
      requires: ['primaryQuery', 'targetUrl', 'rankingMetrics', 'hypothesis'],
      allowedSurfaces: ['title', 'meta_description', 'h1', 'intro', 'h2', 'faq', 'internal_links']
    },
    technical: { requires: ['targetUrl'], allowedSurfaces: ['technical_metadata', 'canonical', 'robots', 'sitemap'] },
    indexing: { requires: ['targetUrl'], allowedSurfaces: ['gsc_inspection', 'sitemap', 'indexing_status'] },
    internal_links: { requires: ['targetUrl'], allowedSurfaces: ['internal_links'] },
    ai_visibility: { requires: ['targetUrl', 'hypothesis'], allowedSurfaces: ['faq', 'entities', 'answer_blocks', 'schema'] },
    unclassified: { requires: ['targetUrl'], allowedSurfaces: [] }
  }
  return contracts[track] || contracts.unclassified
}

function actionText(action) {
  return [action.title, action.category, action.why, action.recommendedAction, action.evidenceType]
    .filter(Boolean).join(' ').toLowerCase()
}

