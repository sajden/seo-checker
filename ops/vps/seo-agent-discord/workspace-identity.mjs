export function workspaceProfileKey(workspace, targetChannelId = null) {
  const repoFullName = canonicalRepoFullName(workspace)
  if (repoFullName) return `repo:${repoFullName}`
  const gscProperty = String(workspace?.gscProperty || '').trim().toLowerCase()
  if (gscProperty) return `gsc:${gscProperty}`
  const workspaceId = String(workspace?.id || '').trim()
  if (workspaceId) return `workspace:${workspaceId}`
  return targetChannelId ? `channel:${targetChannelId}` : 'default'
}

export function canonicalRepoFullName(workspace) {
  const direct = String(workspace?.repoFullName || '').trim().toLowerCase()
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(direct)) return direct
  const candidates = [workspace?.id, workspace?.label, workspace?.workspaceKey]
    .map((value) => String(value || '').trim().toLowerCase())
  for (const candidate of candidates) {
    const composite = candidate.match(/__([a-z0-9_.-]+\/[a-z0-9_.-]+?)(?:__(?:main|master))?$/)
    if (composite?.[1]) return composite[1]
    if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(candidate)) return candidate
  }
  return ''
}
