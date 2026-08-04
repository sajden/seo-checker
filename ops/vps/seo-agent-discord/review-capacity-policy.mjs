export function reviewCapacityCheck({ state, workspace, action, maxPendingReviews = 3 }) {
  const repoFullName = String(workspace?.repoFullName || '').trim()
  if (!repoFullName) return { ok: true, reason: 'workspace_without_repo', pendingCount: 0, limit: maxPendingReviews }
  const pending = Object.entries(state?.codeActionResults || {}).filter(([, record]) => {
    if (!['review_ready', 'operator_approved', 'promotion_running'].includes(String(record?.status || ''))) return false
    return String(record?.result?.repoFullName || '').trim() === repoFullName
  })
  const targetUrl = normalizeSeoUrl(action?.targetUrl || action?.url)
  if (targetUrl && pending.some(([, record]) => {
    const reviewTarget = normalizeSeoUrl(record?.result?.reviewContext?.targetUrl || record?.result?.targetUrl)
    return reviewTarget && reviewTarget === targetUrl
  })) {
    return { ok: false, reason: 'target_review_pending', pendingCount: pending.length, limit: maxPendingReviews }
  }
  const limit = Math.max(1, Number(maxPendingReviews || 3))
  if (pending.length >= limit) {
    return { ok: false, reason: 'workspace_review_limit', pendingCount: pending.length, limit }
  }
  return { ok: true, reason: 'review_capacity_available', pendingCount: pending.length, limit }
}

export function normalizeSeoUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    parsed.hash = ''
    parsed.search = ''
    parsed.hostname = parsed.hostname.toLowerCase()
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    return parsed.toString()
  } catch {
    return ''
  }
}
