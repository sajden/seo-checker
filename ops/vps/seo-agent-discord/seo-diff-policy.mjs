const STOP_WORDS = new Set(['och', 'att', 'för', 'från', 'med', 'som', 'till', 'den', 'det', 'en', 'ett', 'på', 'i', 'av'])

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function meaningfulTerms(keyword) {
  return normalize(keyword).split(/\s+/).filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
}

function isRankingAction(action = {}) {
  const type = String(action.actionType || '').toLowerCase()
  const text = `${action.title || ''} ${action.category || ''} ${action.evidenceType || ''}`.toLowerCase()
  return type.startsWith('ranking_') || (action.keyword && action.evidenceType === 'gsc') || /\b(ctr|ranking|rankning|sokord|sökord|query|serp-gap)\b/.test(text)
}

function changedContent(diff) {
  return String(diff || '')
    .split(/\r?\n/)
    .filter((line) => /^\+[^+]/.test(line))
    .join(' ')
}

function hasSurface(diff, surface) {
  const text = String(diff || '').toLowerCase()
  const patterns = {
    title: /<title|title\s*[:=]|generateMetadata|metadata|pageTitle/,
    meta_description: /meta\s*description|description\s*[:=]/,
    h1: /<h1|h1\s*[:=]/,
    intro: /<p|intro|inledning|lead/,
    h2: /<h2|h2\s*[:=]/,
    faq: /faq|frequently|vanliga fragor|vanliga frågor|question|answer/,
    internal_links: /href\s*=|internal.?link|internlank|internlänk|anchor/,
  }
  return patterns[surface] ? patterns[surface].test(text) : false
}

export function validateSeoDiff({ action = {}, diff = '', changedFiles = [] } = {}) {
  if (!isRankingAction(action)) return { ok: true, reason: 'non_ranking_action' }
  const keyword = String(action.keyword || action.primaryQuery || '').trim()
  if (!keyword) return { ok: false, reason: 'ranking_action_missing_primary_query' }
  const terms = meaningfulTerms(keyword)
  const additions = normalize(changedContent(diff))
  const matchedTerms = terms.filter((term) => additions.includes(term))
  if (!terms.length || matchedTerms.length < Math.max(1, Math.ceil(terms.length * 0.5))) {
    return { ok: false, reason: 'ranking_diff_does_not_reflect_primary_query', matchedTerms, requiredTerms: terms }
  }
  if (changedFiles.some((file) => /\.css$/i.test(String(file)))) {
    return { ok: false, reason: 'ranking_action_changed_visual_css' }
  }
  const actionType = String(action.actionType || '').toLowerCase()
  const requiredFields = Array.isArray(action.requiredFields) && action.requiredFields.length
    ? action.requiredFields
    : actionType === 'ranking_ctr' ? ['title', 'h1', 'intro'] : ['h1', 'intro', 'h2']
  const matchedFields = requiredFields.filter((field) => hasSurface(diff, field))
  const minFields = actionType === 'ranking_ctr' ? 1 : 1
  if (matchedFields.length < minFields) {
    return { ok: false, reason: 'ranking_diff_missing_expected_seo_surface', requiredFields, matchedFields }
  }
  return {
    ok: true,
    reason: 'ranking_diff_validated',
    matchedTerms,
    matchedFields,
    requiredFields
  }
}

