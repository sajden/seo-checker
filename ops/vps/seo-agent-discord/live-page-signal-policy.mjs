function combinedActionText(action) {
  return [
    action?.title,
    action?.why,
    action?.recommendedAction,
    ...(Array.isArray(action?.evidence) ? action.evidence : [])
  ].filter(Boolean).join('\n')
}

function normalizedSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function keywordCoverageClaim(action) {
  const keyword = String(action?.keyword || '').trim()
  if (!keyword) return null
  const text = normalizedSearchText(combinedActionText(action))
  if (!/tack keyword|lagg in keyword|keyword hittades inte|title h1 h2 meta|exakt sokfras|exakt query|saknar exakt/.test(text)) return null
  return keyword
}

function significantKeywordTokens(keyword) {
  const stopWords = new Set(['och', 'att', 'den', 'det', 'for', 'fran', 'med', 'mot', 'pa', 'som', 'till', 'vid'])
  return normalizedSearchText(keyword)
    .split(' ')
    .filter((token) => token.length >= 2 && !stopWords.has(token))
}

function tokenCoveredBySignal(token, words) {
  return words.some((word) => word === token
    || (token.length >= 3 && word.startsWith(token))
    || (word.length >= 3 && token.startsWith(word)))
}

export function keywordAlreadyCovered(keyword, signals) {
  const tokens = significantKeywordTokens(keyword)
  if (!tokens.length) return false
  const words = normalizedSearchText([
    signals?.title,
    signals?.h1,
    signals?.metaDescription
  ].filter(Boolean).join(' ')).split(' ').filter(Boolean)
  return tokens.every((token) => tokenCoveredBySignal(token, words))
}

export function claimedMissingSignals(action) {
  const text = combinedActionText(action)
  return {
    title: /\bTitle\s*:\s*saknas\b/i.test(text),
    h1: /\bH1\s*:\s*saknas\b/i.test(text),
    metaDescription: /\bMeta\s*:\s*saknas\b/i.test(text)
  }
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return match?.[1]?.trim() || ''
}

function plainText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|quot|#39);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractLivePageSignals(html) {
  const source = String(html || '')
  const title = plainText(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])
  const h1 = plainText(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1])
  let metaDescription = ''
  for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0]
    if (attribute(tag, 'name').toLowerCase() !== 'description') continue
    metaDescription = attribute(tag, 'content')
    break
  }
  return { title, h1, metaDescription }
}

export async function validateActionAgainstLivePage(action, fetchImpl = fetch) {
  const claimed = claimedMissingSignals(action)
  const claimedKeyword = keywordCoverageClaim(action)
  if (!Object.values(claimed).some(Boolean) && !claimedKeyword) {
    return { ok: true, checked: false, reason: 'no_missing_signal_claim' }
  }
  const targetUrl = String(action?.targetUrl || action?.url || '').trim()
  if (!/^https:\/\//i.test(targetUrl)) {
    return { ok: false, checked: false, reason: 'missing_signal_claim_without_https_target' }
  }
  try {
    const response = await fetchImpl(targetUrl, {
      redirect: 'follow',
      headers: { 'user-agent': 'SebCastwall-SEO-Agent/1.0', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      return { ok: false, checked: true, reason: `live_page_http_${response.status}`, targetUrl }
    }
    const present = extractLivePageSignals(await response.text())
    if (claimedKeyword && keywordAlreadyCovered(claimedKeyword, present)) {
      return {
        ok: false,
        checked: true,
        reason: 'live_page_already_covers_keyword_semantically',
        targetUrl,
        keyword: claimedKeyword,
        present
      }
    }
    const contradicted = Object.entries(claimed)
      .filter(([key, isMissing]) => isMissing && Boolean(present[key]))
      .map(([key]) => key)
    if (contradicted.length) {
      return {
        ok: false,
        checked: true,
        reason: `live_page_contradicts_missing_signals:${contradicted.join(',')}`,
        targetUrl,
        contradicted,
        present
      }
    }
    return { ok: true, checked: true, reason: 'live_page_confirms_missing_signals', targetUrl, present }
  } catch (error) {
    return {
      ok: false,
      checked: true,
      reason: `live_page_validation_failed:${error?.message || String(error)}`,
      targetUrl
    }
  }
}
