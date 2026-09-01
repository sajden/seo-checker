const DAY_MS = 24 * 60 * 60 * 1000

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}`
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function expectedCtr(position) {
  if (position <= 3) return 0.12
  if (position <= 5) return 0.08
  if (position <= 10) return 0.045
  if (position <= 20) return 0.025
  return 0.012
}

function intentForQuery(query) {
  const text = normalizeText(query)
  if (/pris|kostnad|boka|boka|kopa|kop|offert|konsult|tjanst|hjalp/.test(text)) return 'commercial'
  if (/hur|vad|varfor|guide|tips|problem|fungerar|skillnad/.test(text)) return 'informational'
  if (/logga in|login|kontakt|telefon|adress/.test(text)) return 'navigational'
  return 'mixed'
}

function actionTypeForRow(row) {
  const position = number(row.position)
  const ctr = number(row.ctr)
  const gap = expectedCtr(position) - ctr
  if (position <= 10 && gap > 0.02) return 'ranking_ctr'
  if (position > 10 && position <= 30) return 'ranking_relevance'
  return 'ranking_coverage'
}

function scoreRow(row, options = {}) {
  const impressions = number(row.impressions)
  const position = number(row.position, 100)
  const ctr = number(row.ctr)
  const ctrGap = Math.max(0, expectedCtr(position) - ctr)
  const positionPotential = position >= 8 && position <= 30 ? 30 : position >= 4 && position < 8 ? 24 : position > 30 && position <= 50 ? 10 : 0
  const impressionValue = Math.min(25, Math.log10(Math.max(1, impressions)) * 8)
  const ctrValue = Math.min(25, ctrGap * 220)
  const businessValue = number(options.businessValue, 0)
  const trendValue = number(options.trendValue, 0)
  return Math.round(positionPotential + impressionValue + ctrValue + businessValue + trendValue)
}

function compactRow(row) {
  const page = row?.page || row?.keys?.[0]
  const query = row?.query || row?.keys?.[1]
  if (!page || !query) return null
  const impressions = number(row.impressions)
  const position = number(row.position, 0)
  if (impressions <= 0 || position <= 0) return null
  return {
    page,
    query,
    clicks: number(row.clicks),
    impressions,
    ctr: number(row.ctr),
    position,
    intent: intentForQuery(query),
    actionType: actionTypeForRow(row),
    score: scoreRow(row),
    reason: position <= 10
      ? 'Sidan ligger redan på sida 1 men tappar klick mot förväntad CTR.'
      : 'Sidan har verifierad synlighet men ligger på position 8–30 och kan förbättras.'
  }
}

export function buildRankingOpportunities({ rows = [], opportunities = [], minImpressions = 10, max = 20 } = {}) {
  const source = [
    ...(Array.isArray(rows) ? rows : []),
    ...(Array.isArray(opportunities) ? opportunities : [])
  ]
  const unique = new Map()
  for (const item of source) {
    const row = compactRow(item)
    if (!row || row.impressions < minImpressions) continue
    if (row.position < 4 || row.position > 30) continue
    const key = `${normalizeUrl(row.page)}|${normalizeText(row.query)}`
    const previous = unique.get(key)
    if (!previous || row.impressions > previous.impressions || row.position < previous.position) unique.set(key, row)
  }
  return [...unique.values()]
    .sort((a, b) => b.score - a.score || b.impressions - a.impressions || a.position - b.position)
    .slice(0, max)
}

export function rankingHypothesisForOpportunity(opportunity) {
  if (!opportunity?.query || !opportunity?.page) return null
  const fields = opportunity.actionType === 'ranking_ctr'
    ? ['title', 'meta_description', 'h1', 'intro']
    : ['title', 'h1', 'intro', 'h2', 'faq', 'internal_links']
  return {
    query: opportunity.query,
    targetUrl: opportunity.page,
    intent: opportunity.intent,
    actionType: opportunity.actionType,
    fields,
    hypothesis: opportunity.actionType === 'ranking_ctr'
      ? `Tydligare SERP-meddelande för "${opportunity.query}" kan höja CTR utan att byta sökintention.`
      : `Bättre täckning av sökintentionen för "${opportunity.query}" kan flytta sidan upp från position ${opportunity.position.toFixed(1)}.`
  }
}

export function rankingEngineVersion() {
  return { version: 2, windowDays: 28, minPosition: 4, maxPosition: 30, updatedAt: new Date().toISOString().slice(0, 10) }
}
