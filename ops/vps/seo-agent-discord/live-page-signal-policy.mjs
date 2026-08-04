function combinedActionText(action) {
  return [
    action?.title,
    action?.why,
    action?.recommendedAction,
    ...(Array.isArray(action?.evidence) ? action.evidence : [])
  ].filter(Boolean).join('\n')
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
  if (!Object.values(claimed).some(Boolean)) {
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
