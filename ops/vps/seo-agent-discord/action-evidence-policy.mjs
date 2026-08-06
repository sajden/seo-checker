export function checkActionEvidenceIntegrity(action, options = {}) {
  const now = Number(options.now || Date.now())
  const maxFreshAgeMs = Number(options.maxFreshAgeMs || 72 * 60 * 60 * 1000)
  const source = String(action?.evidenceSource || '').trim().toLowerCase()
  const verifiedType = String(action?.verifiedEvidence?.type || '').trim().toLowerCase()
  const claims = [action?.why, ...(Array.isArray(action?.evidence) ? action.evidence : [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const claimsGsc = /\bgsc\b|search console/.test(claims)
  if (claimsGsc && verifiedType !== 'gsc' && !source.includes('gsc')) {
    return { ok: false, reason: 'gsc_claim_without_gsc_provenance' }
  }
  if (verifiedType && source.startsWith('fresh_') && !source.includes(verifiedType)) {
    return { ok: false, reason: 'verified_evidence_source_mismatch' }
  }
  if (source.startsWith('fresh_')) {
    const runAt = Date.parse(action?.evidenceRunAt || action?.verifiedEvidence?.runAt || '')
    if (!Number.isFinite(runAt)) return { ok: false, reason: 'fresh_evidence_missing_timestamp' }
    if (now - runAt > maxFreshAgeMs) return { ok: false, reason: 'fresh_evidence_is_stale' }
  }
  return { ok: true, reason: 'evidence_integrity_ok' }
}
