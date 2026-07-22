const DAY_MS = 24 * 60 * 60 * 1000

export function classifyGscIssue({ issue, evidence = {}, now = new Date() }) {
  const type = String(issue?.type || '').toLowerCase()
  const reason = String(issue?.reason || '').toLowerCase()
  const targetUrl = String(issue?.affectedUrl || '')
  const status = Number(evidence.httpStatus || 0)

  if (
    evidence.redirected &&
    evidence.finalUrl &&
    normalizeUrl(evidence.finalUrl) !== normalizeUrl(targetUrl) &&
    Number(evidence.finalStatus || 0) >= 200 &&
    Number(evidence.finalStatus || 0) < 400
  ) {
    return decision('resolved', 'live_redirect_resolves_gsc_signal', 0)
  }

  if (evidence.redirected && Number(evidence.finalStatus || 0) >= 400) {
    return decision('review', `redirect_target_http_${evidence.finalStatus}`, 95)
  }

  if (type === 'not_found_404') {
    if (status > 0 && status !== 404) return decision('resolved', 'url_no_longer_returns_404', 0)
    if (status === 404 && evidence.inSitemap === false && isExpiredEventUrl(targetUrl, now)) {
      return decision('monitor', 'expected_expired_event_404_not_in_sitemap', 5)
    }
    return decision('review', evidence.inSitemap ? 'live_sitemap_contains_404' : 'unresolved_404_requires_link_check', evidence.inSitemap ? 95 : 65)
  }

  if (type.includes('noindex') || /robots|blocked/.test(type) || /noindex|robots/.test(reason)) {
    return decision('review', 'indexing_directive_may_block_valid_page', 100)
  }

  if (isCanonicalIssue(type, reason)) {
    return decision('review', 'canonical_intent_requires_verification', 85)
  }

  if (isDiscoveryIssue(type, reason) && status === 200 && evidence.inSitemap === true) {
    return decision('inspect', 'live_indexable_page_should_be_checked_before_review', 70)
  }

  if (status >= 400) return decision('review', `live_http_${status}`, 90)
  return decision('review', 'unclassified_gsc_issue', 50)
}

export function groupGscReviewCandidates(candidates) {
  const groups = new Map()
  const singles = []
  for (const candidate of candidates) {
    if (candidate?.issue?.type !== 'not_found_404') {
      singles.push(candidate)
      continue
    }
    const host = hostFromUrl(candidate.issue.affectedUrl) || 'workspace'
    const key = `${host}:not_found_404`
    const group = groups.get(key) || []
    group.push(candidate)
    groups.set(key, group)
  }

  const grouped = [...groups.values()].map((items) => items.length === 1
    ? items[0]
    : {
        ...items[0],
        batch: true,
        issues: items.map((item) => item.issue),
        score: Math.max(...items.map((item) => Number(item.score || 0))) + Math.min(items.length, 10)
      })

  return [...singles, ...grouped].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
}

export function isExpiredEventUrl(value, now = new Date(), graceDays = 7) {
  const url = String(value || '')
  if (!/\/evenemang\//i.test(url)) return false
  const matches = [...url.matchAll(/(20\d{2})-(\d{2})-(\d{2})/g)]
  if (!matches.length) return false
  const [, year, month, day] = matches[matches.length - 1]
  const eventDate = Date.UTC(Number(year), Number(month) - 1, Number(day))
  if (!Number.isFinite(eventDate)) return false
  return now.getTime() - eventDate > graceDays * DAY_MS
}

function isCanonicalIssue(type, reason) {
  return /canonical|kanonisk|duplicate/.test(`${type} ${reason}`)
}

function isDiscoveryIssue(type, reason) {
  return /gsc-indexing-issue|discovered|crawled.*not indexed|känner inte till|not known|not indexed/.test(`${type} ${reason}`)
}

function decision(disposition, reason, score) {
  return { disposition, reason, score }
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '') || '/'}`
  } catch {
    return String(value || '').replace(/\/$/, '')
  }
}

function hostFromUrl(value) {
  try { return new URL(String(value || '')).hostname.replace(/^www\./, '') } catch { return '' }
}
