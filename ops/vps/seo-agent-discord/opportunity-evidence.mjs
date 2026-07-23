function normalizeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return `${url.hostname.toLowerCase()}${normalizePath(url.pathname)}`
  } catch {
    return normalizePath(raw)
  }
}

function normalizePath(value) {
  const path = String(value || '').trim().split(/[?#]/, 1)[0]
  const normalized = `/${path.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '')}`
  return normalized === '/' ? '/' : normalized.toLowerCase()
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function compactGscRow(row) {
  const [page, query] = Array.isArray(row?.keys) ? row.keys : []
  if (!page || !query) return null
  return {
    page,
    query,
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
    ctr: Number(row.ctr || 0),
    position: Number(row.position || 0)
  }
}

function compactGscOpportunity(item) {
  if (!item?.page || !item?.query) return null
  return {
    page: item.page,
    query: item.query,
    clicks: Number(item.clicks || 0),
    impressions: Number(item.impressions || 0),
    ctr: Number(item.ctr || 0),
    position: Number(item.position || 0),
    opportunityType: item.opportunityType || null,
    recommendedAction: item.recommendedAction || null
  }
}

function compactPageOpportunity(item) {
  if (!item?.url) return null
  return {
    url: item.url,
    priority: item.priority || null,
    status: item.status || null,
    title: item.title || null,
    metaDescription: item.metaDescription || null,
    h1Text: item.h1Text || null,
    keywords: Array.isArray(item.keywords)
      ? item.keywords.slice(0, 6).map((keyword) => ({
          query: keyword?.query || null,
          status: keyword?.status || null,
          gscMatched: Boolean(keyword?.gscMatched),
          evidence: Array.isArray(keyword?.evidence) ? keyword.evidence.slice(0, 3) : []
        }))
      : []
  }
}

function compactCrawlSignal(item) {
  if (!item?.url) return null
  const issues = []
  if (Number(item.status || 0) >= 400) issues.push(`http_${item.status}`)
  if (!item.title) issues.push('missing_title')
  if (!item.metaDescription) issues.push('missing_meta_description')
  if (Number(item.h1Count || 0) !== 1) issues.push(`h1_count_${Number(item.h1Count || 0)}`)
  if (item.canonical === null || item.canonical === '') issues.push('missing_canonical')
  if (!issues.length) return null
  return { url: item.url, issues }
}

export function buildOpportunityEvidenceContext(batch) {
  const details = batch?.lastRunDetails || {}
  const gscRows = (Array.isArray(details.gscRows) ? details.gscRows : [])
    .map(compactGscRow)
    .filter((item) => item && item.impressions > 0)
    .sort((a, b) => b.impressions - a.impressions || a.position - b.position)
    .slice(0, 40)
  const gscOpportunities = (Array.isArray(details.gscSearchOpportunities) ? details.gscSearchOpportunities : [])
    .map(compactGscOpportunity)
    .filter((item) => item && item.impressions > 0)
    .sort((a, b) => b.impressions - a.impressions || a.position - b.position)
    .slice(0, 24)
  const pageOpportunities = (Array.isArray(details.pageSeoOpportunities) ? details.pageSeoOpportunities : [])
    .map(compactPageOpportunity)
    .filter(Boolean)
    .slice(0, 16)
  const crawlSignals = (Array.isArray(details.crawlPages) ? details.crawlPages : [])
    .map(compactCrawlSignal)
    .filter(Boolean)
    .slice(0, 20)

  return {
    runAt: batch?.lastRunAt || batch?.lastRunSummary?.ranAt || null,
    gscRows,
    gscOpportunities,
    pageOpportunities,
    crawlSignals,
    counts: {
      gscRows: gscRows.length,
      gscOpportunities: gscOpportunities.length,
      pageOpportunities: pageOpportunities.length,
      crawlSignals: crawlSignals.length
    }
  }
}

function sameTarget(left, right) {
  return Boolean(left && right && normalizeUrl(left) === normalizeUrl(right))
}

function keywordMatches(left, right) {
  const a = normalizeText(left)
  const b = normalizeText(right)
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)))
}

export function validateOpportunityEvidence(action, evidenceContext) {
  const evidenceType = String(action?.evidenceType || '').trim().toLowerCase()
  const targetUrl = String(action?.targetUrl || '').trim()
  const keyword = String(action?.keyword || action?.focus || '').trim()
  if (!targetUrl || !keyword) return { ok: false, reason: 'missing_target_or_keyword' }

  if (evidenceType === 'gsc') {
    const candidates = [
      ...(evidenceContext?.gscOpportunities || []),
      ...(evidenceContext?.gscRows || [])
    ]
    const match = candidates.find((item) => (
      sameTarget(item?.page, targetUrl)
      && keywordMatches(item?.query, keyword)
      && Number(item?.impressions || 0) > 0
    ))
    if (!match) return { ok: false, reason: 'gsc_evidence_not_verified' }
    return {
      ok: true,
      reason: 'verified_gsc_signal',
      evidence: {
        type: 'gsc',
        runAt: evidenceContext?.runAt || null,
        page: match.page,
        query: match.query,
        clicks: Number(match.clicks || 0),
        impressions: Number(match.impressions || 0),
        ctr: Number(match.ctr || 0),
        position: Number(match.position || 0)
      }
    }
  }

  if (evidenceType === 'crawl') {
    const crawlMatch = (evidenceContext?.crawlSignals || []).find((item) => sameTarget(item?.url, targetUrl))
    if (!crawlMatch) return { ok: false, reason: 'crawl_evidence_not_verified' }
    return {
      ok: true,
      reason: 'verified_crawl_signal',
      evidence: {
        type: 'crawl',
        runAt: evidenceContext?.runAt || null,
        page: crawlMatch.url,
        issues: crawlMatch.issues
      }
    }
  }

  return { ok: false, reason: 'unsupported_or_missing_evidence_type' }
}
