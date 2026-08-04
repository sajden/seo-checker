export function applyCodexBriefRewrite(action, codexBrief, expectedWorkspaceHost = '') {
  if (codexBrief?.decision !== 'rewrite') return action
  const targetUrl = String(codexBrief.targetUrl || '').trim()
  let parsed = null
  try { parsed = new URL(targetUrl) } catch { return null }
  if (parsed.protocol !== 'https:') return null
  const expectedHost = normalizeHost(expectedWorkspaceHost)
  const actualHost = normalizeHost(parsed.hostname)
  if (expectedHost && actualHost !== expectedHost) return null
  return {
    ...action,
    originalTargetUrl: action?.targetUrl || action?.url || null,
    targetUrl,
    url: targetUrl,
    title: codexBrief.title || action?.title,
    recommendedAction: codexBrief.doThis || action?.recommendedAction,
    why: codexBrief.why || action?.why,
    codexRewriteApplied: true
  }
}

function normalizeHost(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase()
}
