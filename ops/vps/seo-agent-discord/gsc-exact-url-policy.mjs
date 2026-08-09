export function normalizeExactUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (url.protocol !== 'https:') return ''
    url.hash = ''
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
    return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '')
  } catch {
    return ''
  }
}

export function exactTargetFromRecords({ action, posted, active, ledger } = {}) {
  for (const candidate of [action?.targetUrl, action?.url, posted?.targetUrl, active?.targetUrl, ledger?.targetUrl]) {
    const normalized = normalizeExactUrl(candidate)
    if (normalized) return normalized
  }
  return ''
}

export function validateExactInspection({ expectedUrl, result } = {}) {
  const expected = normalizeExactUrl(expectedUrl)
  if (!expected) return { ok: false, indexed: false, reason: 'missing_exact_target_url' }

  const inspected = normalizeExactUrl(result?.targetUrl)
  if (!inspected) return { ok: false, indexed: false, reason: 'inspection_result_missing_target_url', expected }
  if (inspected !== expected) return { ok: false, indexed: false, reason: 'inspection_target_mismatch', expected, inspected }

  const inspection = result?.inspection || {}
  const indexed = inspection.status === 'indexed' && Number(inspection.confidence || 0) >= 0.8
  if (!indexed) return { ok: true, indexed: false, reason: inspection.reason || inspection.status || 'not_indexed', expected, inspected }

  const googleCanonical = normalizeExactUrl(inspection.googleCanonical)
  if (googleCanonical && googleCanonical !== expected) {
    return { ok: true, indexed: false, reason: 'google_canonical_differs', expected, inspected, googleCanonical }
  }
  return { ok: true, indexed: true, reason: inspection.reason || 'indexed', expected, inspected, googleCanonical }
}
