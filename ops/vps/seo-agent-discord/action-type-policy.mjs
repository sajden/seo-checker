export function isIndexingActionIdentity(action = {}) {
  const id = String(action.id || '').toLowerCase()
  const category = String(action.category || action.kind || '').toLowerCase()
  const issueType = String(action.issueType || action.gscIssueType || '').toLowerCase()
  const text = `${action.title || ''} ${action.why || ''} ${action.action || ''} ${action.recommendedAction || ''}`.toLowerCase()
  const hasContentChange = /title|h1|h2|meta|copy|faq|content|intro|internl[aä]nk|internal link|ctr|query/.test(text)
  return id.includes('gsc-indexing-issue')
    || (category === 'indexing' && !hasContentChange)
    || (issueType === 'gsc-indexing-issue' && !hasContentChange)
    || /kontrollera indexering|verifiera indexering|url inspection|beg[aä]r indexering|webbadressen [aä]r ok[aä]nd/.test(text)
}
