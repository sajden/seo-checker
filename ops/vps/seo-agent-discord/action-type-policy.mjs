export function isIndexingActionIdentity(action = {}) {
  const id = String(action.id || '').toLowerCase()
  const category = String(action.category || action.kind || '').toLowerCase()
  const issueType = String(action.issueType || action.gscIssueType || '').toLowerCase()
  const text = `${action.title || ''} ${action.why || ''} ${action.recommendedAction || ''}`.toLowerCase()
  return id.includes('gsc-indexing-issue')
    || category === 'indexing'
    || issueType === 'gsc-indexing-issue'
    || /kontrollera indexering|verifiera indexering|url inspection|beg[aä]r indexering|webbadressen [aä]r ok[aä]nd/.test(text)
}
