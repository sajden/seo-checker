const DAY_MS = 24 * 60 * 60 * 1000

export function buildGscExperimentSnapshot({ batch, targetUrl, keyword = '', capturedAt = new Date().toISOString() }) {
  const details = batch?.lastRunDetails || {}
  const summary = batch?.lastRunSummary || {}
  const rows = Array.isArray(details.gscRows) ? details.gscRows : []
  const sourceRunAt = batch?.lastRunAt || summary.ranAt || details.checkedAt || null
  const rawRows = Number(summary.gscRawRows ?? details.gscRawRows ?? rows.length)
  const rowLimit = Number(details.gscRowLimit || 500)
  const coverage = rawRows >= rowLimit ? 'truncated' : 'complete'
  const normalizedTarget = normalizeUrl(targetUrl)
  const normalizedKeyword = normalizeText(keyword)
  const pageRows = rows.filter((row) => normalizeUrl(row?.keys?.[0]) === normalizedTarget)
  const queryRows = normalizedKeyword
    ? pageRows.filter((row) => normalizeText(row?.keys?.[1]) === normalizedKeyword)
    : []
  const page = metricForRows(pageRows, coverage)
  const query = normalizedKeyword ? metricForRows(queryRows, coverage) : null
  const runMs = Date.parse(sourceRunAt || '')

  return {
    version: 1,
    capturedAt,
    sourceRunAt,
    windowStart: Number.isFinite(runMs) ? new Date(runMs - 28 * DAY_MS).toISOString().slice(0, 10) : null,
    windowEnd: Number.isFinite(runMs) ? new Date(runMs).toISOString().slice(0, 10) : null,
    windowDays: 28,
    targetUrl,
    keyword,
    coverage,
    rawRows,
    returnedRows: rows.length,
    page,
    query,
    status: page.available || query?.available ? 'ready' : 'unavailable'
  }
}

export function evaluateExperimentMeasurement({ baseline, followup, phase = 'day14' }) {
  if (!baseline || !followup) return unavailableResult(phase, 'missing_snapshot')
  const scope = selectScope(baseline, followup)
  if (!scope) return unavailableResult(phase, 'target_not_observed_in_complete_gsc_window')
  const before = baseline[scope]
  const after = followup[scope]
  if (!before?.available || !after?.available) return unavailableResult(phase, `incomplete_${scope}_coverage`)

  const deltas = {
    clicks: after.clicks - before.clicks,
    impressions: after.impressions - before.impressions,
    ctr: after.ctr - before.ctr,
    position: metricDelta(before.position, after.position, true)
  }
  const totalImpressions = before.impressions + after.impressions
  const positive = []
  const negative = []
  if (deltas.clicks >= 1) positive.push('clicks')
  if (deltas.clicks <= -1) negative.push('clicks')
  if (Math.abs(deltas.impressions) >= 5 && ratioChange(before.impressions, after.impressions) >= 0.2) positive.push('impressions')
  if (Math.abs(deltas.impressions) >= 5 && ratioChange(before.impressions, after.impressions) <= -0.2) negative.push('impressions')
  if (before.impressions >= 20 && after.impressions >= 20 && deltas.ctr >= 0.01) positive.push('ctr')
  if (before.impressions >= 20 && after.impressions >= 20 && deltas.ctr <= -0.01) negative.push('ctr')
  if (before.impressions >= 10 && after.impressions >= 10 && deltas.position >= 1.5) positive.push('position')
  if (before.impressions >= 10 && after.impressions >= 10 && deltas.position <= -1.5) negative.push('position')

  let outcome = 'inconclusive'
  if (totalImpressions < 10 && before.clicks === 0 && after.clicks === 0) outcome = 'insufficient_data'
  else if (positive.length && negative.length) outcome = 'mixed'
  else if (positive.length) outcome = 'improved'
  else if (negative.length) outcome = 'declined'

  const rawConfidence = totalImpressions >= 200 ? 'high' : totalImpressions >= 40 ? 'medium' : 'low'
  const windowOverlapDays = phase === 'day14' ? 14 : 0
  const confidence = windowOverlapDays > 0 ? 'low' : rawConfidence
  return {
    phase,
    scope,
    outcome,
    confidence,
    rawConfidence,
    windowOverlapDays,
    before,
    after,
    deltas,
    positiveSignals: positive,
    negativeSignals: negative,
    reason: measurementReason(outcome, scope, before, after, deltas, positive, negative)
  }
}

export function nextExperimentPhase(experiment, now = new Date()) {
  const completedMs = Date.parse(experiment?.completedAt || '')
  if (!Number.isFinite(completedMs)) return null
  const ageDays = Math.floor((now.getTime() - completedMs) / DAY_MS)
  const followups = experiment?.measurements?.followups || {}
  if (ageDays >= 14 && !followups.day14) return 'day14'
  if (ageDays >= 30 && !followups.day30) return 'day30'
  return null
}

export function nextMeasurementDate(experiment) {
  const completedMs = Date.parse(experiment?.completedAt || '')
  if (!Number.isFinite(completedMs)) return null
  const followups = experiment?.measurements?.followups || {}
  if (!followups.day14) return new Date(completedMs + 14 * DAY_MS).toISOString().slice(0, 10)
  if (!followups.day30) return new Date(completedMs + 30 * DAY_MS).toISOString().slice(0, 10)
  return null
}

function metricForRows(rows, coverage) {
  if (!rows.length) {
    if (coverage === 'complete') return { available: true, observed: false, clicks: 0, impressions: 0, ctr: 0, position: null, rowCount: 0 }
    return { available: false, observed: false, clicks: null, impressions: null, ctr: null, position: null, rowCount: 0 }
  }
  const clicks = sum(rows, 'clicks')
  const impressions = sum(rows, 'impressions')
  const weightedPosition = impressions > 0
    ? rows.reduce((total, row) => total + number(row.position) * number(row.impressions), 0) / impressions
    : null
  return {
    available: true,
    observed: true,
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: weightedPosition,
    rowCount: rows.length
  }
}

function selectScope(baseline, followup) {
  const queryImpressions = Number(baseline.query?.impressions || 0) + Number(followup.query?.impressions || 0)
  const queryClicks = Number(baseline.query?.clicks || 0) + Number(followup.query?.clicks || 0)
  if (baseline.query?.available && followup.query?.available && (queryImpressions >= 10 || queryClicks > 0)) return 'query'
  if (baseline.page?.available && followup.page?.available) return 'page'
  return null
}

function unavailableResult(phase, reason) {
  return { phase, scope: null, outcome: 'insufficient_data', confidence: 'none', reason }
}

function measurementReason(outcome, scope, before, after, deltas, positive, negative) {
  const label = scope === 'query' ? 'sökfrågan på målsidan' : 'målsidan totalt'
  const metrics = `${before.clicks}->${after.clicks} klick, ${before.impressions}->${after.impressions} visningar, position ${formatNumber(before.position)}->${formatNumber(after.position)}`
  if (outcome === 'improved') return `${label} förbättrades (${positive.join(', ')}): ${metrics}.`
  if (outcome === 'declined') return `${label} försämrades (${negative.join(', ')}): ${metrics}.`
  if (outcome === 'mixed') return `${label} gav blandade signaler (+${positive.join(', ')}; -${negative.join(', ')}): ${metrics}.`
  if (outcome === 'insufficient_data') return `${label} har för lite GSC-data för en säker slutsats: ${metrics}.`
  return `${label} saknar en tydlig förändring: ${metrics}; delta klick ${deltas.clicks}.`
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.hostname.replace(/^www\./, '').toLowerCase()}${path}${url.search}`
  } catch {
    return String(value || '').trim().toLowerCase().replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/+$/, '')
  }
}

function normalizeText(value) {
  return String(value || '').trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ')
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + number(row?.[key]), 0)
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function ratioChange(before, after) {
  if (before === 0) return after > 0 ? 1 : 0
  return (after - before) / before
}

function metricDelta(before, after, lowerIsBetter = false) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0
  return lowerIsBetter ? before - after : after - before
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '-'
}
