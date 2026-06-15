import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const AGENT_ROOT = '/home/deploy/seo-agent-discord'
export const AGENT_SPEC_FILES = ['AGENTS.md', 'SKILLS.md', 'TOOLS.md', 'POLICIES.md', 'MEMORY.md']

export function readAgentSpecs(limitPerFile = 6000) {
  return AGENT_SPEC_FILES.map((file) => {
    const path = join(AGENT_ROOT, file)
    try {
      return `# ${file}\n${readFileSync(path, 'utf8').slice(0, limitPerFile)}`
    } catch {
      return `# ${file}\nmissing`
    }
  }).join('\n\n')
}

export function agentSpecStatus() {
  return AGENT_SPEC_FILES.map((file) => {
    const path = join(AGENT_ROOT, file)
    if (!existsSync(path)) return { file, ok: false, bytes: 0, updatedAt: null }
    const stat = statSync(path)
    return { file, ok: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() }
  })
}

export function workspaceGoalSummary(workspace) {
  const label = [workspace?.label, workspace?.id, workspace?.gscProperty, workspace?.repoFullName].filter(Boolean).join(' ').toLowerCase()
  if (label.includes('sebcastwall')) return 'AI, AI-agenter, AI-automation, kodning, app/web, interna verktyg och AI-utbildningar.'
  if (label.includes('natverkskollen')) return 'Events, startup events, entreprenörer, nätverkande och evergreen eventlandningssidor.'
  if (label.includes('parkeringspolaren')) return 'Parkering, flygplatsparkering, långtidsparkering, lokal intent, indexering och konvertering.'
  if (/\b(vag|väg|road|route|trafik|traffic|weather|väder|driving)\b/.test(label)) return 'Vägväder, ruttplanering, trafikläge, vägförhållanden och konkreta rese-/bilscenarion.'
  if (/\b(event|events|nätverk|network|startup|meetup)\b/.test(label)) return 'Event discovery, nätverk, stadssidor och konkreta eventkluster.'
  if (/\b(parking|parkering|airport|flygplats|garage)\b/.test(label)) return 'Parkering, bokning, lokal intent, pris/avstånd och konvertering.'
  if (/\b(ai|automation|app|web|konsult|consult|agent)\b/.test(label)) return 'AI, automation, utveckling, tjänstecase och köparnära proof.'
  return 'Ranka högre på relevant och värdefull sökefterfrågan.'
}

export function agentRuntimeSnapshot({ workspace = null, state = {}, config = {} } = {}) {
  return {
    structure: {
      agent: 'AGENTS.md',
      skills: 'SKILLS.md',
      tools: 'TOOLS.md',
      policies: 'POLICIES.md',
      memory: 'MEMORY.md',
      specFiles: agentSpecStatus()
    },
    config: {
      codeAutomationEnabled: Boolean(config.codeAutomationEnabled),
      codexChatEnabled: Boolean(config.codexChatEnabled),
      smartOutboundGuardEnabled: Boolean(config.smartOutboundGuardEnabled),
      automationEnabled: Boolean(config.automationEnabled),
      workspaceChannelCount: Number(config.workspaceChannelCount || 0)
    },
    workspace: workspace ? {
      id: workspace.id,
      label: workspace.label,
      gscProperty: workspace.gscProperty,
      repoFullName: workspace.repoFullName,
      branch: workspace.branch || 'main',
      goal: workspaceGoalSummary(workspace)
    } : null,
    memory: {
      savedGuidanceCount: Object.keys(state.workspaceGuidance || {}).length,
      outboundLessons: (state.outboundGuardLessons || []).length,
      outboundIncidents: (state.outboundMessageIncidents || []).length,
      readinessTracked: Object.keys(state.workspaceReadiness || {}).length
    }
  }
}
