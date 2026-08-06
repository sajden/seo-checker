export function applyIssueHysteresis(rawIssues, previous = {}, options = {}) {
  const liveFailureThreshold = Math.max(1, Number(options.liveFailureThreshold || 3))
  const defaultFailureThreshold = Math.max(1, Number(options.defaultFailureThreshold || 1))
  const recoveryThreshold = Math.max(1, Number(options.recoveryThreshold || 2))
  const previousActive = new Map(
    (Array.isArray(previous.activeIssues) ? previous.activeIssues : [])
      .filter((issue) => issue?.id)
      .map((issue) => [String(issue.id), issue])
  )
  const raw = new Map(rawIssues.filter((issue) => issue?.id).map((issue) => [String(issue.id), issue]))
  const priorObservations = previous.issueObservations && typeof previous.issueObservations === 'object'
    ? previous.issueObservations
    : {}
  const ids = new Set([...raw.keys(), ...previousActive.keys(), ...Object.keys(priorObservations)])
  const activeIssues = []
  const issueObservations = {}

  for (const id of ids) {
    const observedIssue = raw.get(id)
    const prior = priorObservations[id] || {}
    const wasActive = previousActive.has(id)
    if (observedIssue) {
      const failureCount = prior.lastObserved === 'failing' ? Number(prior.failureCount || 0) + 1 : 1
      const threshold = id.startsWith('live-') ? liveFailureThreshold : defaultFailureThreshold
      const isActive = wasActive || failureCount >= threshold
      issueObservations[id] = { lastObserved: 'failing', failureCount, successCount: 0 }
      if (isActive) activeIssues.push(observedIssue)
      continue
    }

    const successCount = prior.lastObserved === 'healthy' ? Number(prior.successCount || 0) + 1 : 1
    if (wasActive && successCount < recoveryThreshold) {
      activeIssues.push(previousActive.get(id))
      issueObservations[id] = { lastObserved: 'healthy', failureCount: 0, successCount }
    }
  }

  activeIssues.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const activeIds = activeIssues.map((issue) => String(issue.id))
  const previousIds = [...previousActive.keys()].sort()
  return {
    activeIssues,
    activeIds,
    issueObservations,
    newlyActiveIds: activeIds.filter((id) => !previousActive.has(id)),
    recoveredIds: previousIds.filter((id) => !activeIds.includes(id))
  }
}
