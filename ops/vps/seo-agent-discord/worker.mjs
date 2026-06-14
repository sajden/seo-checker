#!/usr/bin/env node
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentRuntimeSnapshot } from './agent-brain.mjs'

const env = loadEnv(['/home/deploy/.hermes/.env', '/home/deploy/seo-agent-discord/.env'])
const DISCORD_API = 'https://discord.com/api/v10'
const token = required('DISCORD_BOT_TOKEN')
const channelId = required('DISCORD_CHANNEL_ID')
const allowedUserId = required('DISCORD_ALLOWED_USER_ID')
const platformApiUrl = (env.PLATFORM_API_URL || 'https://dashboard2-platform-api.sebastian-castwall.workers.dev').replace(/\/$/, '')
const platformToken = env.PLATFORM_API_TOKEN || ''
const googleAdsOauthRedirectUri = env.GOOGLE_ADS_OAUTH_REDIRECT_URI || 'http://localhost:1455/oauth/google-ads/callback'
const googleAdsOauthState = env.GOOGLE_ADS_OAUTH_STATE || 'seo-agent-google-ads-oauth'
const pollMs = Number(env.SEO_AGENT_POLL_MS || '60000')
const dailyHourUtc = Number(env.SEO_AGENT_DAILY_HOUR_UTC || '4')
const runCheckEveryMs = Number(env.SEO_AGENT_RUN_CHECK_MS || '900000')
const integrationDoctorEveryMs = Number(env.SEO_AGENT_INTEGRATION_DOCTOR_MS || '21600000')
const activeActionReminderMs = Number(env.SEO_AGENT_ACTIVE_ACTION_REMINDER_MS || String(6 * 60 * 60 * 1000))
const staleRunningMs = Number(env.SEO_AGENT_STALE_RUNNING_MS || String(2 * 60 * 60 * 1000))
const staleQueuedApprovedMs = Number(env.SEO_AGENT_STALE_APPROVED_QUEUE_MS || String(36 * 60 * 60 * 1000))
const staleActiveActionMs = Number(env.SEO_AGENT_STALE_ACTIVE_ACTION_MS || String(30 * 60 * 60 * 1000))
const workspaceChannels = parseWorkspaceChannels(env.SEO_AGENT_WORKSPACE_CHANNELS || '{}')
const defaultWorkspaceId = env.SEO_AGENT_DEFAULT_WORKSPACE_ID || ''
const guildId = env.DISCORD_GUILD_ID || ''
const autoCreateWorkspaceChannels = env.SEO_AGENT_AUTO_CREATE_CHANNELS !== 'false'
const automationEnabled = env.SEO_AGENT_AUTONOMY_ENABLED !== 'false'
const codeAutomationEnabled = env.SEO_AGENT_CODE_AUTOMATION_ENABLED === 'true'
const codexChatEnabled = env.SEO_AGENT_CODEX_CHAT_ENABLED !== 'false'
const smartOutboundGuardEnabled = env.SEO_AGENT_SMART_OUTBOUND_GUARD !== 'false'
const stateDir = '/home/deploy/seo-agent-discord/state'
const statePath = join(stateDir, 'state.json')
const agentSpecFiles = ['AGENTS.md', 'SKILLS.md', 'TOOLS.md', 'POLICIES.md', 'MEMORY.md']
const processStartedAtMs = Date.now()
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
const state = loadState()
ensureAutonomousAgentState()

log('starting', { channelId, allowedUserId, platformApiUrl, pollMs, dailyHourUtc, runCheckEveryMs, workspaceChannelCount: Object.keys(workspaceChannels).length, automationEnabled, codeAutomationEnabled })
startDiscordInteractionClient()
await postStartupOnce()

setInterval(() => {
  tick().catch((error) => log('tick_failed', { error: error?.message || String(error) }))
}, pollMs).unref()

while (true) {
  await tick().catch((error) => log('tick_failed', { error: error?.message || String(error) }))
  await sleep(pollMs)
}

async function tick() {
  cleanupStaleRuntimeState()
  await processDiscordReplies()
  const workspaces = await listWorkspaces()
  await ensureDailyRunsForWorkspaces(workspaces)
  await postReadinessForWorkspaces(workspaces)
  await postPendingActionsForWorkspaces(workspaces)
  await maybePrepareAutonomousCodeWork(workspaces)
  await maybeRunIntegrationDoctor(workspaces)
  saveState()
}

async function postStartupOnce() {
  if (state.startedAt) return
  state.startedAt = new Date().toISOString()
  await sendDiscordMessage('SEO Agent är online. Jag postar SEO-actions här och lyssnar på `approve <id>`, `skip <id>`, `deprioritize <id>` och `why <id>` från allowlistad användare.')
  saveState()
}

async function maybeStartDailySeoRuns() {
  const now = new Date()
  if (now.getUTCHours() !== dailyHourUtc) return
  const today = now.toISOString().slice(0, 10)
  if (state.dailyRunDates?.[today]) return
  if (!platformToken) {
    await sendDiscordMessage('SEO Agent daily-run kunde inte starta: saknar Platform API runner-token.', channelId)
    state.dailyRunDates = { ...(state.dailyRunDates || {}), [today]: { status: 'failed_missing_token', at: now.toISOString() } }
    return
  }
  try {
    const result = await fetchPlatformJson('/api/platform/seo-monitor/workspaces/run-daily', {
      method: 'POST',
      body: JSON.stringify({ source: 'seo-agent-discord', triggeredAt: now.toISOString() })
    })
    state.dailyRunDates = { ...(state.dailyRunDates || {}), [today]: { status: 'started', at: now.toISOString(), startedCount: result.startedCount ?? null } }
    await sendDiscordMessage(`Daglig SEO-run startad för ${result.startedCount ?? 'okänt antal'} workspace(s). Jag varnar här om något fallerar.`, channelId)
  } catch (error) {
    state.dailyRunDates = { ...(state.dailyRunDates || {}), [today]: { status: 'failed', at: now.toISOString(), error: error?.message || String(error) } }
    await sendDiscordMessage(`Daglig SEO-run misslyckades: ${error?.message || String(error)}\nNästa felsökningssteg: kontrollera Platform API runner-token och SEO Monitor workspaces.`, channelId)
  }
}

async function listWorkspaces() {
  const payload = await fetchPlatformJson('/api/platform/seo-monitor/workspaces')
  return Array.isArray(payload.workspaces) ? payload.workspaces : []
}

async function ensureDailyRunsForWorkspaces(workspaces) {
  if (!automationEnabled) return
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const shouldCheck = !state.lastRunCheckAt || Date.now() - Date.parse(state.lastRunCheckAt) > runCheckEveryMs
  if (!shouldCheck) return
  state.lastRunCheckAt = now.toISOString()
  for (const workspace of workspaces) {
    const targetChannelId = await channelForWorkspace(workspace)
    const readiness = await workspaceReadiness(workspace)
    state.workspaceReadiness = state.workspaceReadiness || {}
    await maybeNotifyReadinessRecovery(workspace, targetChannelId, readiness)
    state.workspaceReadiness[workspace.id] = readiness
    if (!targetChannelId) continue
    if (!readiness.gscConfigured || !readiness.repoConfigured) {
      await sendOncePerDay(`readiness-missing:${workspace.id}:${today}`, targetChannelId, formatReadinessMessage(workspace, readiness))
      continue
    }
    if (readiness.lastRunDate === today) continue
    if (state.workspaceRunDates?.[`${workspace.id}:${today}`]) continue
    try {
      const run = await fetchPlatformJson('/api/platform/runs', {
        method: 'POST',
        body: JSON.stringify({
          moduleKey: 'seo-monitor',
          mode: 'scheduled',
          runProfile: 'content',
          gscProperty: workspace.gscProperty,
          repoFullName: workspace.repoFullName,
          branch: workspace.branch,
          label: workspace.label
        })
      })
      state.workspaceRunDates = { ...(state.workspaceRunDates || {}), [`${workspace.id}:${today}`]: { status: 'started', runId: run.runId || run.id || null, at: now.toISOString() } }
      await sendDiscordMessage(`Startade dagens SEO-run för ${workspace.label}. Jag postar actions när resultat finns.`, targetChannelId)
    } catch (error) {
      state.workspaceRunDates = { ...(state.workspaceRunDates || {}), [`${workspace.id}:${today}`]: { status: 'failed', error: error?.message || String(error), at: now.toISOString() } }
      await sendDiscordMessage(`Kunde inte starta dagens SEO-run för ${workspace.label}: ${error?.message || String(error)}\nFelsökningsloop: kontrollera Platform API, SEO Monitor batch och GSC/repo-mappning.`, targetChannelId)
    }
  }
}

async function postReadinessForWorkspaces(workspaces) {
  const today = new Date().toISOString().slice(0, 10)
  for (const workspace of workspaces) {
    const targetChannelId = await channelForWorkspace(workspace)
    if (!targetChannelId) continue
    const readiness = await workspaceReadiness(workspace)
    state.workspaceReadiness = state.workspaceReadiness || {}
    await maybeNotifyReadinessRecovery(workspace, targetChannelId, readiness)
    state.workspaceReadiness[workspace.id] = readiness
    if (readiness.ready) continue
    await sendOncePerDay(`readiness:${workspace.id}:${today}`, targetChannelId, formatReadinessMessage(workspace, readiness))
  }
}

async function maybeNotifyReadinessRecovery(workspace, targetChannelId, readiness) {
  if (!targetChannelId) return
  const previous = state.workspaceReadiness?.[workspace.id]
  if (!previous || previous.ready || !readiness.ready) return
  const today = new Date().toISOString().slice(0, 10)
  const recoveryKey = `readiness-recovered:${workspace.id}:${today}`
  const reason = humanReadinessIssue(previous)
  await sendOncePerDay(recoveryKey, targetChannelId, [
    `SEO Agent är redo igen för ${workspace.label}. Ingen åtgärd krävs från dig.`,
    `Tidigare problem: ${reason}`,
    readiness.lastRunAt ? `Senaste SEO-run: ${formatDateTime(readiness.lastRunAt)}` : '',
    'Nästa steg: jag postar ett konkret SEO-kort här när det finns något att godkänna.'
  ].filter(Boolean).join('\n'))
}

async function workspaceReadiness(workspace) {
  const batchPayload = await fetchPlatformJson(`/api/platform/seo-monitor/batch?gscProperty=${encodeURIComponent(workspace.gscProperty || '')}&repoFullName=${encodeURIComponent(workspace.repoFullName || '')}&branch=${encodeURIComponent(workspace.branch || '')}`).catch((error) => ({ error: error?.message || String(error), batch: null }))
  const batch = batchPayload.batch || null
  const lastRunAt = batch?.lastRunAt || batch?.lastRunSummary?.ranAt || null
  const lastRunDate = lastRunAt ? new Date(lastRunAt).toISOString().slice(0, 10) : null
  const checks = {
    gscConfigured: Boolean(workspace.gscProperty),
    repoConfigured: Boolean(workspace.repoFullName),
    batchAvailable: Boolean(batch),
    lastRunAt,
    lastRunDate,
    actionCount: Number(batch?.lastRunSummary?.seoActionItems || batch?.lastRunDetails?.seoActionItems?.length || 0),
    batchError: batchPayload.error || null,
  }
  return {
    ...checks,
    ready: checks.gscConfigured && checks.repoConfigured && checks.batchAvailable,
  }
}

function formatReadinessMessage(workspace, readiness) {
  const missing = readinessMissingItems(workspace, readiness)
  const needsUserAction = !readiness.gscConfigured || !readiness.repoConfigured
  const headline = needsUserAction
    ? `SEO Agent behöver setup för ${workspace.label}`
    : `SEO Agent väntar på ny SEO-data för ${workspace.label}`
  const nextStep = needsUserAction
    ? `Gör detta: öppna Dashboard2 -> SEO Monitor -> Workspaces/Integrations och fyll i ${missing.join(' och ')}.`
    : 'Ingen åtgärd krävs från dig just nu. Jag försöker hämta eller starta ny SEO-run automatiskt och postar ett kort när det finns ett beslut.'
  return [
    headline,
    nextStep,
    `Status: ${humanReadinessIssue(readiness)}`,
    readiness.lastRunAt ? `Senaste SEO-run: ${formatDateTime(readiness.lastRunAt)}` : 'Senaste SEO-run: saknas',
    `Workspace: ${workspace.label} · GSC: ${workspace.gscProperty || 'saknas'} · Repo: ${workspace.repoFullName || 'saknas'}`
  ].join('\n')
}

function readinessMissingItems(workspace, readiness) {
  const missing = []
  if (!readiness.gscConfigured) missing.push('GSC property')
  if (!readiness.repoConfigured) missing.push('GitHub repo')
  if (!readiness.batchAvailable && !missing.length) missing.push('SEO batch')
  return missing
}

function humanReadinessIssue(readiness) {
  if (!readiness?.gscConfigured) return 'GSC property saknas.'
  if (!readiness?.repoConfigured) return 'GitHub repo saknas.'
  if (readiness?.batchAvailable) return 'SEO-data finns.'
  const error = String(readiness?.batchError || '')
  if (/seo_batch_not_found|platform_404/i.test(error)) return 'Ingen färsk SEO-batch hittades ännu.'
  if (/502|bad gateway|platform_502/i.test(error)) return 'Platform API svarade tillfälligt med 502.'
  if (/fetch failed|timeout|network/i.test(error)) return 'Tillfälligt nätverks- eller Platform API-fel.'
  if (error) return 'SEO-batch kunde inte hämtas just nu.'
  return 'SEO-batch saknas.'
}

function formatDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

async function postPendingActionsForWorkspaces(workspaces) {
  if (!workspaces.length) {
    await postPendingActions({ workspace: null, targetChannelId: channelId })
    return
  }
  for (const workspace of workspaces) {
    const targetChannelId = await channelForWorkspace(workspace)
    if (!targetChannelId) {
      await notifyMissingWorkspaceChannel(workspace)
      continue
    }
    try {
      await postPendingActions({ workspace, targetChannelId })
    } catch (error) {
      const healed = await selfHealPlatformActionsFetch({ workspace, targetChannelId, error })
      if (healed.resolved) {
        log('workspace_actions_fetch_self_healed', { workspace: workspace.label || workspace.id, error: error?.message || String(error), resolution: healed.resolution })
        continue
      }
      const today = new Date().toISOString().slice(0, 10)
      await sendOncePerDay(`actions-fetch:${workspace.id}:${today}`, targetChannelId, [
        `Kunde inte hämta SEO-actions för ${workspace.label}.`,
        `Fel: ${error?.message || String(error)}`,
        `Självläkning: ${healed.summary}`,
        'Agenten fortsätter med övriga workspaces och försöker igen automatiskt.'
      ].join('\n'))
      log('workspace_actions_fetch_failed', { workspace: workspace.label || workspace.id, error: error?.message || String(error), selfHeal: healed })
    }
  }
}

async function selfHealPlatformActionsFetch({ workspace, targetChannelId, error }) {
  const incidentId = `platform-actions-fetch:${workspace?.id || workspace?.label || 'default'}:${Date.now()}`
  const originalError = error?.message || String(error)
  if (isSeoBatchNotFoundError(error)) {
    const readiness = {
      gscConfigured: Boolean(workspace?.gscProperty),
      repoConfigured: Boolean(workspace?.repoFullName),
      batchAvailable: false,
      lastRunAt: null,
      lastRunDate: null,
      actionCount: 0,
      batchError: 'seo_batch_not_found',
      ready: false
    }
    state.workspaceReadiness = state.workspaceReadiness || {}
    if (workspace?.id) state.workspaceReadiness[workspace.id] = readiness
    logThrottled(`seo_batch_not_found:${workspace?.id || workspace?.repoFullName || workspace?.label || 'default'}`, 30 * 60 * 1000, 'seo_batch_not_found_actions_suppressed', {
      workspace: workspace?.label || workspace?.id || workspace?.repoFullName,
      gscProperty: workspace?.gscProperty || null,
      repoFullName: workspace?.repoFullName || null,
      branch: workspace?.branch || null
    })
    saveState()
    return { resolved: true, resolution: 'seo_batch_not_found_readiness_recorded', attempts: [] }
  }
  state.platformIncidents = state.platformIncidents || {}
  state.platformIncidents[incidentId] = {
    workspace: workspace?.label || workspace?.id || null,
    originalError,
    startedAt: new Date().toISOString(),
    status: 'checking'
  }
  saveState()

  const path = buildSeoMonitorActionsPath(workspace, 5)
  const fallbackPath = workspace?.repoFullName && workspace?.gscProperty
    ? buildSeoMonitorActionsPath(workspace, 5, { includeGscProperty: false })
    : null
  const attempts = []

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) await sleep(2500 * attempt)
    try {
      const check = await platformEndpointProbe(path)
      attempts.push({ attempt, ...check })
      if (check.ok) {
        clearSeoActionsResourceLimitFallback(workspace)
        state.platformIncidents[incidentId] = {
          ...state.platformIncidents[incidentId],
          status: 'resolved',
          resolvedAt: new Date().toISOString(),
          attempts
        }
        saveState()
        if (attempt > 1) {
          await sendOncePerDay(`actions-fetch-self-healed:${workspace.id}:${new Date().toISOString().slice(0, 10)}`, targetChannelId, [
            `SEO Agent självläkte actions-hämtning för ${workspace.label}.`,
            `Ursprungsfel: ${originalError}`,
            `Fix: Platform API svarade korrekt JSON igen efter retry ${attempt}. Ingen manuell åtgärd behövs.`
          ].join('\n'))
        }
        return { resolved: true, resolution: `retry_${attempt}_ok`, attempts }
      }
      if (fallbackPath && isPlatformResourceLimitProbe(check)) {
        const fallbackCheck = await platformEndpointProbe(fallbackPath)
        attempts.push({ attempt, route: 'repo_only', ...fallbackCheck })
        if (fallbackCheck.ok) {
          rememberSeoActionsResourceLimitFallback(workspace, new Error(check.error || `platform_${check.status}`))
          state.platformIncidents[incidentId] = {
            ...state.platformIncidents[incidentId],
            status: 'resolved',
            resolvedAt: new Date().toISOString(),
            attempts,
            resolution: 'repo_only_fallback_ok'
          }
          saveState()
          return { resolved: true, resolution: 'repo_only_fallback_ok', attempts }
        }
      }
    } catch (probeError) {
      attempts.push({ attempt, ok: false, error: probeError?.message || String(probeError) })
    }
  }

  const doctor = await platformEndpointProbe('/api/platform/integrations/gsc/status').catch((doctorError) => ({ ok: false, error: doctorError?.message || String(doctorError) }))
  let codeRepair = null
  if (codeAutomationEnabled) {
    codeRepair = await runSelfRepairCodex({
      id: incidentId,
      workspace: workspace?.label || workspace?.id || null,
      error: originalError,
      path,
      attempts,
      doctor
    }).catch((repairError) => ({ ok: false, error: repairError?.message || String(repairError) }))
  }
  state.platformIncidents[incidentId] = {
    ...state.platformIncidents[incidentId],
    status: codeRepair?.ok ? 'code_repair_attempted' : 'unresolved',
    unresolvedAt: new Date().toISOString(),
    attempts,
    doctor,
    codeRepair
  }
  saveState()
  const last = attempts[attempts.length - 1]
  if (codeRepair?.ok && codeRepair.changed) {
    await sendDiscordMessage([
      `SEO Agent försökte laga sin egen kod för ${workspace?.label || 'workspace'}.`,
      `Ursprungsfel: ${originalError}`,
      `Resultat: patch gjord och syntaxcheck OK. Jag startar om agenten och försöker igen automatiskt.`
    ].join('\n'), targetChannelId)
    scheduleSelfRestart()
    return { resolved: true, resolution: 'code_repair_applied_restart_scheduled', attempts, doctor, codeRepair }
  }
  return {
    resolved: false,
    summary: `retry/probe misslyckades (${last?.error || last?.status || 'okänt'}). Doctor: ${doctor.ok ? 'GSC status svarade' : doctor.error || doctor.status || 'fel'}. Kodfix: ${codeRepair ? (codeRepair.ok ? 'körd utan patch' : codeRepair.error || 'misslyckad') : 'ej körd'}`,
    attempts,
    doctor,
    codeRepair
  }
}

async function runSelfRepairCodex(incident) {
  if (state.selfRepairRunning) return { ok: false, error: 'self_repair_already_running' }
  state.selfRepairRunning = { id: incident.id, startedAt: new Date().toISOString() }
  saveState()
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const inputPath = join(stateDir, 'self-repair-incident.json')
    writeFileSync(inputPath, JSON.stringify(incident, null, 2))
    const result = await exec('/usr/bin/node', ['/home/deploy/seo-agent-discord/seo-agent-self-repair-runner.mjs', inputPath], {
      cwd: '/home/deploy/seo-agent-discord',
      env: { ...process.env, PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}` },
      timeout: 12 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024
    })
    const parsed = JSON.parse(result.stdout || '{}')
    return { ok: true, ...parsed }
  } finally {
    state.selfRepairRunning = null
    saveState()
  }
}

function scheduleSelfRestart() {
  setTimeout(async () => {
    try {
      const { execFile } = await import('node:child_process')
      execFile('systemctl', ['--user', 'restart', 'seo-agent-discord.service'])
    } catch (error) {
      log('self_restart_failed', { error: error?.message || String(error) })
    }
  }, 1500).unref()
}

async function platformEndpointProbe(path) {
  const headers = {
    accept: 'application/json',
    ...(platformToken ? { authorization: `Bearer ${platformToken}` } : {})
  }
  const response = await fetch(`${platformApiUrl}${path}`, { headers })
  const text = await response.text()
  const contentType = response.headers.get('content-type') || ''
  const preview = text.replace(/\s+/g, ' ').slice(0, 180)
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    return { ok: false, status: response.status, contentType, preview, error: 'invalid_json_or_html' }
  }
  return {
    ok: response.ok && contentType.includes('application/json'),
    status: response.status,
    contentType,
    preview: preview.slice(0, 80),
    actionCount: Array.isArray(parsed.actions) ? parsed.actions.length : undefined,
    resourceLimit: isPlatformResourceLimitPayload(response.status, parsed, preview),
    error: response.ok ? null : parsed?.error || parsed?.title || parsed?.detail || preview
  }
}

async function maybePrepareAutonomousCodeWork(workspaces) {
  const now = new Date()
  if (!state.lastCodeReadinessCheckAt || Date.now() - Date.parse(state.lastCodeReadinessCheckAt) > 6 * 60 * 60 * 1000) {
    state.lastCodeReadinessCheckAt = now.toISOString()
    const status = await localAutomationStatus()
    state.localAutomationStatus = status
    if (!status.ready) {
      await sendOncePerDay(`code-auth:${now.toISOString().slice(0, 10)}`, channelId, [
        'Kodautomation är inte redo ännu.',
        `Codex: ${status.codex}`,
        `GitHub push: ${status.github}`,
        `Repo checkout: ${status.repos}`,
        'Agenten kan fortsätta SEO-runs och beslut, men startar inte kodändringar förrän Codex-login och GitHub repo-access är klara.'
      ].join('\n'))
    }
  }
  if (!codeAutomationEnabled) return
  const status = state.localAutomationStatus || await localAutomationStatus()
  if (status.codex !== 'ready') return
  await processApprovedCodeActions(workspaces)
}

async function maybeRunIntegrationDoctor(workspaces) {
  const now = new Date()
  if (state.lastIntegrationDoctorAt && Date.now() - Date.parse(state.lastIntegrationDoctorAt) < integrationDoctorEveryMs) return
  state.lastIntegrationDoctorAt = now.toISOString()
  const report = await buildIntegrationDoctorReport(workspaces)
  state.integrationDoctorStatus = report.summary
  const problems = report.checks.filter((check) => !check.ok)
  if (!problems.length) return
  const signature = problems.map((item) => `${item.key}:${item.status}`).join('|')
  const today = now.toISOString().slice(0, 10)
  if (state.lastIntegrationDoctorAlert?.date === today && state.lastIntegrationDoctorAlert?.signature === signature) return
  state.lastIntegrationDoctorAlert = { date: today, signature, at: now.toISOString() }
  await sendDiscordMessage(formatIntegrationDoctorMessage(report, true), channelId)
}

async function buildIntegrationDoctorReport(workspaces) {
  const [gsc, googleAds, automation] = await Promise.allSettled([
    fetchPlatformJson('/api/platform/integrations/gsc/status'),
    fetchPlatformJson('/api/platform/ad-automation/keyword-metrics', {
      method: 'POST',
      body: JSON.stringify({ keywords: ['ai agenter företag'] })
    }),
    localAutomationStatus(),
  ])
  const gscPayload = settledValue(gsc, null)
  const googleAdsPayload = settledValue(googleAds, null)
  const automationPayload = settledValue(automation, { codex: 'missing', github: 'missing', repos: 'missing', ready: false })
  const workspaceChecks = []
  for (const workspace of workspaces) {
    const github = await fetchPlatformJson(`/api/platform/integrations/github/status?gscProperty=${encodeURIComponent(workspace.gscProperty || '')}&repoFullName=${encodeURIComponent(workspace.repoFullName || '')}&branch=${encodeURIComponent(workspace.branch || '')}`).catch((error) => ({ error: error?.message || String(error), connected: false }))
    workspaceChecks.push({
      key: `github:${workspace.id}`,
      label: `GitHub source: ${workspace.label}`,
      ok: Boolean(github.connected || github.configured),
      status: github.connected || github.configured ? 'connected' : github.error || 'not_connected',
      fix: github.connected || github.configured ? '' : 'Välj repo i Dashboard2 SEO Monitor workspace, eller kontrollera Platform API GitHub access.'
    })
  }
  const checks = [
    {
      key: 'gsc',
      label: 'Google Search Console OAuth',
      ok: Boolean(gscPayload?.connected ?? gscPayload?.hasStoredRefreshToken),
      status: gscPayload ? String(gscPayload.connected ?? gscPayload.hasStoredRefreshToken ? 'connected' : gscPayload.status ?? 'not_connected') : settledErrorMessage(gsc),
      fix: 'Skriv `gsc oauth` i Discord eller koppla om i Dashboard2 -> SEO Monitor -> Integrations.'
    },
    {
      key: 'google_ads',
      label: 'Google Ads Keyword Planner OAuth',
      ok: Boolean(googleAdsPayload?.status === 'ready'),
      status: googleAdsPayload ? String(googleAdsPayload.status || googleAdsPayload.error || 'unknown') : settledErrorMessage(googleAds),
      fix: googleAdsPayload?.error
        ? `Skriv \`google ads oauth\`. Fel: ${googleAdsPayload.error}`
        : 'Skriv `google ads oauth` för att skapa ny refresh token.'
    },
    {
      key: 'codex',
      label: 'Codex auth på VPS',
      ok: automationPayload.codex === 'ready',
      status: automationPayload.codex,
      fix: 'Kör `codex login --device-auth` på VPS om den blir röd.'
    },
    {
      key: 'github_push',
      label: 'GitHub push/deploy keys',
      ok: automationPayload.github === 'ready' && automationPayload.repos === 'ready',
      status: `github=${automationPayload.github}, repos=${automationPayload.repos}`,
      fix: 'Kontrollera deploy keys med write access och repo-checkouts på VPS.'
    },
    ...workspaceChecks
  ]
  return {
    generatedAt: new Date().toISOString(),
    checks,
    summary: Object.fromEntries(checks.map((check) => [check.key, check.status]))
  }
}

function formatIntegrationDoctorMessage(report, onlyProblems = false) {
  const checks = onlyProblems ? report.checks.filter((check) => !check.ok) : report.checks
  return [
    onlyProblems ? 'Integration doctor: åtgärd krävs' : 'Integration doctor: aktuell status',
    `Tid: ${report.generatedAt}`,
    '',
    ...checks.map((check) => `${check.ok ? 'OK' : 'FIX'} ${check.label}: ${check.status}${check.ok ? '' : `\nFix: ${check.fix}`}`),
    '',
    'Kommandon: `google ads oauth`, `gsc oauth`, `doctor`.'
  ].join('\n').slice(0, 1900)
}

function settledValue(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback
}

function settledErrorMessage(result) {
  return result.status === 'rejected' ? result.reason?.message || String(result.reason) : 'unknown'
}

async function processApprovedCodeActions(workspaces) {
  if (state.codeActionRunning) return
  state.codeActionResults = state.codeActionResults || {}
  const queued = await processQueuedApprovedCodeAction(workspaces)
  if (queued) return
  for (const workspace of workspaces) {
    const targetChannelId = await channelForWorkspace(workspace)
    if (!targetChannelId || !workspace.repoFullName) continue
    const payload = await fetchActionsForChat(workspace).catch((error) => ({ error: error?.message || String(error), actions: [] }))
    const actions = Array.isArray(payload.actions) ? payload.actions : []
    const approved = actions.find((action) =>
      action?.status === 'approved'
      && action?.id
      && !state.codeActionResults[action.id]
      && isCodeAction(action)
    )
    if (!approved) continue
    state.codeActionRunning = { actionId: approved.id, startedAt: new Date().toISOString() }
    recordActionLedger(approved, workspace, targetChannelId, 'coding_started', { source: 'platform_approved' })
    saveState()
    try {
      const result = await runCodexAction({ ...approved, repoFullName: workspace.repoFullName, branch: workspace.branch || 'main' })
      state.codeActionResults[approved.id] = { status: 'completed', completedAt: new Date().toISOString(), result }
      recordActionLedger(approved, workspace, targetChannelId, 'completed', { commit: result.commit || null, diffStat: result.diffStat || null, repoFullName: workspace.repoFullName })
      clearActiveAction(approved.id)
      const commitUrl = result.commit ? githubCommitUrl(workspace.repoFullName, result.commit) : ''
      await sendDiscordMessage([
        `Kodaction klar för ${workspace.label}: ${approved.title}`,
        result.commit ? `Commit: ${result.commit}` : '',
        commitUrl ? `GitHub: ${commitUrl}` : '',
        result.diffStat ? `Diff:\n\`\`\`\n${String(result.diffStat).slice(0, 1200)}\n\`\`\`` : ''
      ].filter(Boolean).join('\n'), targetChannelId)
    } catch (error) {
      const failure = classifyCodeActionFailure(error)
      state.codeActionResults[approved.id] = { status: failure.status, failedAt: new Date().toISOString(), error: error?.message || String(error), failure }
      recordActionLedger(approved, workspace, targetChannelId, failure.ledgerEvent, { error: error?.message || String(error), failure })
      clearActiveAction(approved.id)
      await sendDiscordMessage(formatCodeActionFailureMessage(workspace.label, approved.title, error, failure), targetChannelId)
    } finally {
      state.codeActionRunning = null
      saveState()
    }
    return
  }
}

async function processQueuedApprovedCodeAction(workspaces) {
  const queue = state.approvedCodeActionQueue || {}
  const entry = Object.values(queue)
    .filter((item) => item?.id && !state.codeActionResults[item.id])
    .sort((a, b) => Date.parse(b.queuedAt || 0) - Date.parse(a.queuedAt || 0))[0]
  if (!entry) return false
  const workspace = workspaces.find((item) => item.repoFullName === entry.repoFullName)
    || workspaces.find((item) => item.label === entry.workspaceSlug)
    || { label: entry.workspaceSlug || entry.repoFullName || 'workspace', repoFullName: entry.repoFullName, branch: entry.branch || 'main' }
  const targetChannelId = entry.channelId || await channelForWorkspace(workspace)
  state.codeActionRunning = { actionId: entry.id, startedAt: new Date().toISOString(), source: 'approved_queue' }
  recordActionLedger(entry, workspace, targetChannelId, 'coding_started', { source: 'approved_queue' })
  saveState()
  try {
    const result = await runCodexAction({ ...entry, repoFullName: entry.repoFullName || workspace.repoFullName, branch: entry.branch || workspace.branch || 'main' })
    state.codeActionResults[entry.id] = { status: 'completed', completedAt: new Date().toISOString(), result }
    recordActionLedger(entry, workspace, targetChannelId, 'completed', {
      commit: result.commit || null,
      diffStat: result.diffStat || null,
      repoFullName: entry.repoFullName || workspace.repoFullName || null
    })
    delete state.approvedCodeActionQueue[entry.id]
    clearActiveAction(entry.id)
    const commitUrl = result.commit ? githubCommitUrl(entry.repoFullName || workspace.repoFullName, result.commit) : ''
    await sendDiscordMessage([
      `Kodaction klar för ${workspace.label || entry.workspaceSlug}: ${entry.title}`,
      result.commit ? `Commit: ${result.commit}` : '',
      commitUrl ? `GitHub: ${commitUrl}` : '',
      result.diffStat ? `Diff:\n\`\`\`\n${String(result.diffStat).slice(0, 1200)}\n\`\`\`` : ''
    ].filter(Boolean).join('\n'), targetChannelId)
  } catch (error) {
    const failure = classifyCodeActionFailure(error)
    state.codeActionResults[entry.id] = { status: failure.status, failedAt: new Date().toISOString(), error: error?.message || String(error), failure }
    recordActionLedger(entry, workspace, targetChannelId, failure.ledgerEvent, { error: error?.message || String(error), failure })
    delete state.approvedCodeActionQueue[entry.id]
    clearActiveAction(entry.id)
    await sendDiscordMessage(formatCodeActionFailureMessage(workspace.label || entry.workspaceSlug, entry.title, error, failure), targetChannelId)
  } finally {
    state.codeActionRunning = null
    saveState()
  }
  return true
}

async function runCodexAction(action) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const inputPath = join(stateDir, 'codex-action-input.json')
  writeFileSync(inputPath, JSON.stringify(action, null, 2))
  const result = await exec('/usr/bin/node', ['/home/deploy/seo-agent-discord/codex-runner.mjs', inputPath], {
    cwd: '/home/deploy/seo-agent-discord',
    env: { ...process.env, PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}` },
    timeout: 45 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
  })
  const text = String(result.stdout || '').trim()
  try { return JSON.parse(text) } catch {}
  const jsonStart = text.lastIndexOf('{')
  if (jsonStart >= 0) {
    try { return JSON.parse(text.slice(jsonStart)) } catch {}
  }
  return { ok: true, stdout: text.slice(-4000) }
}

function classifyCodeActionFailure(error) {
  const message = error?.message || String(error)
  const text = message.toLowerCase()
  if (text.includes('repo checkout missing') || text.includes('clone failed') || text.includes('permission denied (publickey)')) {
    return {
      status: 'infra_failed',
      ledgerEvent: 'failed',
      category: 'repo_access',
      retryable: true,
      operatorSummary: 'Repo-checkout eller deploy key saknas. Runnern försöker numera auto-klona om SSH-host/deploy key finns.'
    }
  }
  if (text.includes('repo is not clean')) {
    return {
      status: 'infra_failed',
      ledgerEvent: 'failed',
      category: 'dirty_worktree',
      retryable: true,
      operatorSummary: 'Repo-checkouten är dirty. Runnern försöker numera bygga och committa avbrutna agentändringar innan ny körning.'
    }
  }
  if (text.includes('codex made no changes')) {
    return {
      status: 'no_changes',
      ledgerEvent: 'deprioritized',
      category: 'no_effect',
      retryable: false,
      operatorSummary: 'Codex hittade ingen meningsfull ändring. Kortet bör inte loopas utan ny instruktion eller färsk SEO-data.'
    }
  }
  if (text.includes('npm err') || text.includes('pnpm') || text.includes('next build') || text.includes('failed to compile') || text.includes('type error')) {
    return {
      status: 'build_failed',
      ledgerEvent: 'failed',
      category: 'build',
      retryable: true,
      operatorSummary: 'Build/test föll efter kodändring. Nästa steg är att låta Codex reparera buildfelet innan ny SEO-action.'
    }
  }
  return {
    status: 'failed',
    ledgerEvent: 'failed',
    category: 'unknown',
    retryable: false,
    operatorSummary: 'Okänt fel. Agenten markerar kortet som failed så det inte loopar tyst.'
  }
}

function formatCodeActionFailureMessage(workspaceLabel, title, error, failure) {
  const errorText = String(error?.message || error || '').slice(0, 1400)
  return [
    `Kodaction kunde inte slutföras för ${workspaceLabel}: ${title}`,
    `Typ: ${failure.category}${failure.retryable ? ' (retrybar)' : ' (ej retry utan ny input)'}`,
    `Agentens bedömning: ${failure.operatorSummary}`,
    '',
    `Fel:\n${errorText}`
  ].join('\n').slice(0, 1900)
}

async function localAutomationStatus() {
  const status = await runLocalDoctor()
  return {
    codex: status.codex,
    github: status.github,
    repos: status.repos,
    ready: status.codex === 'ready' && status.github === 'ready' && status.repos === 'ready'
  }
}

async function runLocalDoctor() {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const [codex, git, repos] = await Promise.allSettled([
      exec('bash', ['-lc', 'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"; command -v codex >/dev/null || { echo missing; exit 0; }; codex doctor 2>&1 | grep -Eiq "no Codex credentials|✗ auth|auth file.*missing" && echo auth_missing || echo ready']),
      exec('bash', ['-lc', 'missing=\"\"; failed=\"\"; for repo in sebcastwall natverkskollen parkeringspolaren-web vagkollen; do if [ ! -d \"$HOME/seo-agent-workspaces/$repo/.git\" ]; then missing=\"$missing ${repo}\"; continue; fi; git -C \"$HOME/seo-agent-workspaces/$repo\" push --dry-run origin HEAD:main >/dev/null 2>&1 || failed=\"$failed ${repo}\"; done; if [ -n \"$failed\" ]; then echo \"missing:${failed# }\"; else echo ready; fi']),
      exec('bash', ['-lc', 'missing=\"\"; for repo in sebcastwall natverkskollen parkeringspolaren-web vagkollen; do test -d \"$HOME/seo-agent-workspaces/$repo/.git\" || missing=\"$missing ${repo}\"; done; if [ -n \"$missing\" ]; then echo \"missing:${missing# }\"; else echo ready; fi']),
    ])
    return {
      codex: settledStdout(codex),
      github: settledStdout(git),
      repos: settledStdout(repos),
    }
  } catch {
    return { codex: 'missing', github: 'missing', repos: 'missing' }
  }
}

function settledStdout(result) {
  if (result.status !== 'fulfilled') return 'missing'
  const stdout = String(result.value.stdout || '').trim()
  if (stdout === 'ready') return 'ready'
  if (stdout === 'auth_missing') return 'auth_missing'
  if (stdout.startsWith('missing:')) return stdout
  return 'missing'
}

async function notifyMissingWorkspaceChannel(workspace) {
  const key = workspace?.id || workspace?.gscProperty || workspace?.repoFullName || workspace?.label || 'unknown'
  const today = new Date().toISOString().slice(0, 10)
  const noticeKey = `${today}:${key}`
  state.missingWorkspaceChannelNotices = state.missingWorkspaceChannelNotices || {}
  if (state.missingWorkspaceChannelNotices[noticeKey]) return
  state.missingWorkspaceChannelNotices[noticeKey] = true
  log('workspace_channel_missing', {
    workspace: workspace?.label || key,
    suggestedChannel: workspaceChannelName(workspace),
    reason: guildId ? 'create_failed_or_missing_permission' : 'missing_discord_guild_id'
  })
}

async function postPendingActions({ workspace, targetChannelId }) {
  const actions = await fetchSeoMonitorActions(workspace, 10)
  const items = Array.isArray(actions.actions) ? actions.actions : []
  ensureWorkspaceProfile(workspace, targetChannelId)
  state.activeActionByWorkspace = state.activeActionByWorkspace || {}
  const activeKey = activeWorkspaceActionKey(workspace, targetChannelId)
  const active = state.activeActionByWorkspace[activeKey]
  if (active && activeActionStillOpen(active, items)) {
    await maybeRemindActiveAction({ workspace, targetChannelId, activeKey, active, actions })
    logThrottled(`active_action_waiting:${activeKey}:${active.actionId}`, 30 * 60 * 1000, 'active_action_waiting', { actionId: active.actionId, activeKey })
    return
  }
  if (active) delete state.activeActionByWorkspace[activeKey]
  const pending = items.filter((item) => item && item.status === 'pending')
  for (const action of prioritizeActionQueue(pending, workspace, targetChannelId)) {
    const id = String(action.id || '')
    if (!id || recentlyPostedAction(id)) continue
    const systemKey = systemClusterKey(action)
    if (systemKey && recentlyPostedSystemKey(systemKey)) continue
    const enrichedAction = await enrichActionWithKeywordMetrics(action)
    if (shouldSkipUnknownVolumeKeywordAction(enrichedAction)) {
      log("skipped_unknown_volume_keyword_action", { id, keyword: enrichedAction.keyword || null })
      continue
    }
    const guard = shouldPostActionCard(enrichedAction, workspace, targetChannelId)
    if (!guard.ok) {
      rememberGuardedAction(enrichedAction, workspace, targetChannelId, guard.reason)
      log('action_card_guarded', { id, workspace: workspace?.label || workspace?.id || null, reason: guard.reason })
      continue
    }
    const message = formatActionMessage(enrichedAction, actions.workspacePolicy, workspace)
    const posted = await sendDiscordMessage(message, targetChannelId, actionComponents(enrichedAction))
    recordActionLedger(enrichedAction, workspace, targetChannelId, 'posted', { messageId: posted.id, systemKey, guard: guard.reason || 'passed' })
    state.postedActionIds[id] = {
      messageId: posted.id,
      channelId: targetChannelId,
      title: enrichedAction.title || '',
      workspaceId: workspace?.id || null,
      postedAt: new Date().toISOString()
    }
    state.activeActionByWorkspace[activeKey] = {
      actionId: id,
      messageId: posted.id,
      channelId: targetChannelId,
      workspaceId: workspace?.id || null,
      firstPostedAt: new Date().toISOString(),
      postedAt: new Date().toISOString()
    }
    state.messageToAction = state.messageToAction || {}
    state.messageToAction[posted.id] = id
    if (systemKey) {
      state.postedSystemKeys = state.postedSystemKeys || {}
      state.postedSystemKeys[systemKey] = { actionId: id, messageId: posted.id, postedAt: new Date().toISOString() }
    }
    
    break
  }
}

async function maybeRemindActiveAction({ workspace, targetChannelId, activeKey, active, actions }) {
  if (!activeActionReminderMs || activeActionReminderMs < 60 * 1000) return
  const postedAtMs = Date.parse(active.remindedAt || active.repostedAt || active.postedAt || '')
  if (!postedAtMs || Date.now() - postedAtMs < activeActionReminderMs) return
  const lastReminderKey = active.lastReminderAt ? Date.parse(active.lastReminderAt) : 0
  if (lastReminderKey && Date.now() - lastReminderKey < activeActionReminderMs) return
  const posted = await repostActiveActionCard(workspace, actions, targetChannelId, {
    intro: 'Påminnelse: det här SEO-kortet väntar fortfarande på beslut.'
  })
  if (!posted) return
  state.activeActionByWorkspace = state.activeActionByWorkspace || {}
  state.activeActionByWorkspace[activeKey] = {
    ...(state.activeActionByWorkspace[activeKey] || active),
    lastReminderAt: new Date().toISOString(),
    reminderCount: Number(active.reminderCount || 0) + 1
  }
  log('active_action_reminded', { actionId: active.actionId, activeKey, messageId: posted.id })
}

function shouldSkipUnknownVolumeKeywordAction(action) {
  const title = String(action?.title || '').toLowerCase()
  const keyword = String(action?.keyword || '').trim()
  const targetUrl = String(action?.targetUrl || '').trim()
  const metrics = action?.keywordMetrics && typeof action.keywordMetrics === 'object' ? action.keywordMetrics : null
  const volume = metrics?.avgMonthlySearches
  const hasKnownVolume = volume !== null && volume !== undefined && volume !== '' && Number(volume) > 0
  const isKeywordOnly = title.includes('täck keyword') || title.includes('serp-gap')
  return Boolean(keyword && !targetUrl && isKeywordOnly && !hasKnownVolume)
}

function activeWorkspaceActionKey(workspace, targetChannelId) {
  return workspace?.id || workspace?.gscProperty || workspace?.repoFullName || targetChannelId || 'default'
}

function activeActionStillOpen(active, items) {
  const actionId = String(active?.actionId || '')
  if (!actionId) return false
  const codeResult = state.codeActionResults?.[actionId]
  if (codeResult && ['completed', 'failed'].includes(String(codeResult.status))) return false
  const item = items.find((candidate) => String(candidate?.id || '') === actionId)
  if (!item) return false
  const status = String(item.status || '')
  return status === 'pending' || status === 'approved'
}

function recentlyPostedAction(actionId) {
  const record = state.postedActionIds?.[String(actionId || '')]
  return recordRecentlyPosted(record)
}

function recentlyPostedSystemKey(systemKey) {
  const record = state.postedSystemKeys?.[String(systemKey || '')]
  return recordRecentlyPosted(record)
}

function recordRecentlyPosted(record) {
  if (!record) return false
  const at = Date.parse(record.repostedAt || record.postedAt || '')
  if (!at) return false
  return Date.now() - at < 20 * 60 * 60 * 1000
}

function clearActiveAction(actionId) {
  if (!actionId || !state.activeActionByWorkspace) return
  for (const [key, active] of Object.entries(state.activeActionByWorkspace)) {
    if (String(active?.actionId || '') === String(actionId)) delete state.activeActionByWorkspace[key]
  }
}

function prioritizeActionQueue(items, workspace = null, targetChannelId = null) {
  const priorityWeight = (priority) => priority === 'critical' ? 0 : priority === 'high' ? 1 : priority === 'medium' ? 2 : 3
  const typeWeight = (item) => {
    const text = String((item?.title || '') + ' ' + (item?.keyword || '') + ' ' + (item?.targetUrl || '') + ' ' + (item?.why || '') + ' ' + (item?.recommendedAction || '')).toLowerCase()
    const workspaceText = String(workspace?.label || workspace?.id || '').toLowerCase()
    const isSebcastwall = workspaceText.includes('sebcastwall')
    const aiFit = /ai[- ]?agent|ai agenter|ai konsult|ai-konsult|ai automatisering|ai-automatisering|automation|app|webbutveckling|kodning|utbildning|kurs|workshop|internverktyg/.test(text)
    const integrationHeavy = /integration|integrationskollen|fortnox|visma|bokföring|bokforing|faktura/.test(text)
    if (text.includes('kontrollera indexering') || text.includes('url inspection') || text.includes('oauth-tokenutbyte')) return 5
    if (text.includes('account status') || text.includes('help_outline') || text.includes('abicart klarna')) return 6
    if (isSebcastwall && integrationHeavy && !aiFit) return 7
    if (isSebcastwall && /ny sida|new page|landningssida|serp-gap|opportunity|ai konsult|ai-konsult|utbildning|kurs|workshop/.test(text) && aiFit) return 0
    if (text.includes('/tjanster/ai-agenter') || text.includes('ai agent') || text.includes('ai agenter') || text.includes('ai automatisering')) return 0
    if (text.includes('/tjanster/') || text.includes('/verktyg/')) return 1
    if (text.includes('serp-gap') || text.includes('täck keyword')) return 2
    return 3
  }
  const guidance = workspaceGuidanceFor(workspace, targetChannelId)
  const guidanceScore = (item) => {
    if (!guidance?.focusTerms?.length) return 0
    const terms = guidance.focusTerms || []
    const text = String((item?.title || '') + ' ' + (item?.keyword || '') + ' ' + (item?.targetUrl || '') + ' ' + (item?.why || '') + ' ' + (item?.recommendedAction || '')).toLowerCase()
    let score = terms.reduce((sum, term) => sum + (text.includes(term) ? 12 : 0), 0)
    const wantsEducationOrCode = terms.some((term) => ['kodning', 'kod', 'utbildning', 'ai utbildning', 'kurs', 'workshop'].includes(term))
    if (wantsEducationOrCode) {
      if (/utbildning|kurs|workshop|kodning|kod|developer|utvecklare/.test(text)) score += 45
      if (/bokföring|bokforing|faktura|fakturahantering|fortnox|visma|integration/.test(text)) score -= 70
      if (/ai[- ]?agent|ai agenter|ai-automatisering|automation/.test(text)) score += 10
    }
    return score
  }
  const score = (item) => {
    const value = Number(item?.priorityScore ?? item?.score ?? NaN)
    const base = Number.isFinite(value) ? value : null
    const boost = guidanceScore(item)
    return base === null ? (boost ? 50 + boost : null) : base + boost
  }
  return [...items].sort((a, b) => {
    const aScore = score(a)
    const bScore = score(b)
    if (aScore !== null && bScore !== null && Math.abs(bScore - aScore) >= 5) return bScore - aScore
    if (aScore !== null && bScore === null) return -1
    if (aScore === null && bScore !== null) return 1
    const byType = typeWeight(a) - typeWeight(b)
    if (byType) return byType
    return priorityWeight(String(a?.priority || 'medium')) - priorityWeight(String(b?.priority || 'medium'))
  })
}

async function processDiscordReplies() {
  const channels = unique([
    channelId,
    ...Object.values(workspaceChannels),
    ...Object.values(state.createdWorkspaceChannels || {}).map((item) => item?.id)
  ])
  for (const targetChannelId of channels) {
    await processDiscordRepliesForChannel(targetChannelId)
  }
}

async function processDiscordRepliesForChannel(targetChannelId) {
  const messages = await discordJson(`/channels/${targetChannelId}/messages?limit=20`)
  if (!Array.isArray(messages)) return
  const sorted = messages.slice().reverse()
  for (const message of sorted) {
    const messageId = String(message.id || '')
    if (!messageId || state.seenMessageIds[messageId]) continue
    state.seenMessageIds[messageId] = true
    if (message.author?.bot) continue
    if (String(message.author?.id || '') !== allowedUserId) continue
    const command = parseCommand(String(message.content || ''))
    if (command) await handleCommand(command, message, targetChannelId)
    else await handleChatMessage(String(message.content || ''), message, targetChannelId)
  }
}

async function handleCommand(command, message, targetChannelId) {
  if (command.decision === 'why') {
    const action = await findAction(command.actionId)
    if (!action) {
      await sendDiscordMessage(`Hittar inte action \`${command.actionId}\`.`, targetChannelId)
      return
    }
    await sendDiscordMessage(`Varför \`${action.id}\`:\n${action.why || 'Ingen förklaring sparad.'}\n\nRekommenderad action: ${action.recommendedAction || 'Ingen action sparad.'}`, targetChannelId)
    return
  }

  const result = await saveActionDecision({
    actionId: command.actionId,
    decision: command.decision,
    reason: command.reason || null,
    source: 'discord',
    discordMessageId: message.id,
    discordChannelId: targetChannelId,
  })
  recordDecisionInLedger(command.actionId, command.decision, targetChannelId, { source: 'discord_command', reason: command.reason || null })
  if (command.decision === 'approved') {
    await rememberApprovedCodeAction(command.actionId, targetChannelId)
    clearActiveAction(command.actionId)
  } else clearActiveAction(command.actionId)
  await sendDiscordMessage(command.decision === 'approved' ? `Approve sparad för \`${result.decision?.actionId || command.actionId}\`. Jag startar kodautomation på nästa agent-tick och postar commit/diff här.` : `Sparat beslut: \`${command.decision}\` för \`${result.decision?.actionId || command.actionId}\`.`, targetChannelId)
  log('decision_saved', { actionId: command.actionId, decision: command.decision })
}

function extractActionIdFromDiscordMessage(message) {
  const content = String(message?.content || '')
  const quoted = content.match(/`(seo_action_[^`\s]+)`/)
  if (quoted?.[1]) return quoted[1]
  const plain = content.match(/(?:^|\s)(seo_action_[a-zA-Z0-9_.:-]+)/)
  return plain?.[1] || null
}

async function rememberApprovedCodeAction(actionId, targetChannelId) {
  const action = await findActionForWorkspace(actionId, targetChannelId).catch(() => null) || fallbackActionFromState(actionId, targetChannelId)
  if (!action || !isCodeAction(action)) return
  const workspace = workspaceForChannel(targetChannelId)
  state.approvedCodeActionQueue = state.approvedCodeActionQueue || {}
  state.approvedCodeActionQueue[actionId] = {
    ...action,
    id: actionId,
    repoFullName: workspace?.repoFullName || action.repoFullName || null,
    branch: workspace?.branch || action.branch || 'main',
    workspaceSlug: workspace?.label || action.workspaceSlug || action.projectSlug || null,
    queuedAt: new Date().toISOString(),
    channelId: targetChannelId
  }
  saveState()
}

function startDiscordInteractionClient() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  })

  client.once('clientReady', () => {
    log('discord_interactions_ready', { user: client.user?.tag || null })
  })

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton()) return
      const customId = String(interaction.customId || '')
      if (!customId.startsWith('seo-decision:') && !customId.startsWith('seo-gsc-ui:')) return
      if (String(interaction.user?.id || '') !== allowedUserId) {
        await interaction.reply({ content: 'Ignored: this Discord user is not allowed to control the SEO agent.', ephemeral: true })
        return
      }

      const actionId = state.messageToAction?.[interaction.message?.id] || extractActionIdFromDiscordMessage(interaction.message)
      if (!actionId) {
        await interaction.reply({ content: 'Jag hittar inte action-id för den här knappen. Jag kunde inte heller läsa ID:t ur meddelandetexten. Skriv `vilket kort?` så postar jag om kortet med ny knapp.', ephemeral: true })
        return
      }
      state.messageToAction = state.messageToAction || {}
      state.messageToAction[interaction.message.id] = actionId
      if (customId.startsWith('seo-gsc-ui:')) {
        await interaction.deferReply({ ephemeral: true })
        const result = await handleGscUiButton(actionId, interaction.channelId)
        await interaction.editReply({ content: result })
        return
      }

      const decision = customId.slice('seo-decision:'.length)
      const result = await saveActionDecision({
        actionId,
        decision,
        reason: null,
        source: 'discord_button',
        discordMessageId: interaction.message.id,
        discordChannelId: interaction.channelId,
      })
      recordDecisionInLedger(actionId, decision, interaction.channelId, { source: 'discord_button' })
      if (decision === 'approved') {
        await rememberApprovedCodeAction(actionId, interaction.channelId)
        clearActiveAction(actionId)
      } else clearActiveAction(actionId)
      await interaction.reply({ content: decision === 'approved' ? `Approve sparad för ${result.decision?.actionId || actionId}. Jag startar kodautomation på nästa agent-tick och postar commit/diff här.` : `Sparat beslut: ${decision} för ${result.decision?.actionId || actionId}.`, ephemeral: true })
      await interaction.message.edit({ components: [] }).catch(() => null)
      log('button_decision_saved', { actionId, decision, discordMessageId: interaction.message.id })
    } catch (error) {
      log('button_decision_failed', { error: error?.message || String(error) })
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `Decision failed: ${error?.message || String(error)}`, ephemeral: true }).catch(() => null)
      }
    }
  })

  client.login(token).catch((error) => log('discord_interactions_login_failed', { error: error?.message || String(error) }))
  return client
}

async function handleGscUiButton(actionId, targetChannelId) {
  const action = await findActionForWorkspace(actionId, targetChannelId)
  if (!action) return `Hittar inte action \`${actionId}\`.`
  if (!isIndexingCheckAction(action)) return 'Det här är inte en GSC/indexeringsaction.'
  const workspace = workspaceForChannel(targetChannelId)
  const targetUrl = action.targetUrl || ''
  const host = targetUrl ? new URL(targetUrl).hostname.replace(/^www\./, '') : String(workspace?.gscProperty || '').replace(/^sc-domain:/, '')
  const result = await runGscFirefoxUiTool({
    command: 'inspect-url',
    workspaceId: workspace?.id || null,
    workspaceHost: host,
    gscProperty: workspace?.gscProperty || '',
    targetUrl
  }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  const observationPath = result?.observation?.path || ''
  const indexedByGsc = result?.inspection?.status === 'indexed' && Number(result?.inspection?.confidence || 0) >= 0.8
  if (indexedByGsc) {
    await saveActionDecision({
      actionId: action.id,
      decision: 'skipped',
      reason: `GSC URL Inspection verified indexed (${result.inspection.reason}, confidence ${Number(result.inspection.confidence).toFixed(2)}).`,
      source: 'discord_gsc_ui_indexed',
      discordMessageId: null,
      discordChannelId: targetChannelId
    }).catch((error) => log('gsc_indexed_decision_failed', { actionId: action.id, error: error?.message || String(error) }))
    clearActiveAction(action.id)
    state.indexingConfirmations = state.indexingConfirmations || {}
    state.indexingConfirmations[`${workspace?.label || workspace?.id || 'workspace'}:${normalizeActionPath(action.targetUrl || '')}`] = {
      status: 'indexed',
      actionId: action.id,
      confirmedAt: new Date().toISOString(),
      source: 'gsc_firefox_ui',
      observationPath,
      inspection: result.inspection
    }
    saveState()
  }
  await sendDiscordMessage([
    `GSC URL Inspection körd för ${workspace?.label || workspace?.id || 'workspace'}.`,
    targetUrl ? `URL att inspektera: ${targetUrl}` : '',
    indexedByGsc ? `Resultat: GSC visar att URL:en är indexerad (${Number(result.inspection.confidence).toFixed(2)} confidence). Jag markerade kortet som hanterat.` : '',
    result.ok && observationPath ? `Observation sparad på VPS: ${observationPath}` : '',
    result.ok && !indexedByGsc ? 'Nästa: kontrollera resultatet i Firefox/noVNC. Jag stänger bara kort automatiskt när GSC-bilden är tydligt indexerad.' : '',
    !result.ok ? `Fel: ${result.error || result.status || 'kunde inte öppna GSC UI'}` : ''
  ].filter(Boolean).join('\n'), targetChannelId)
  return result.ok
    ? indexedByGsc
      ? 'Jag körde GSC URL Inspection, verifierade indexering och markerade kortet som hanterat.'
      : 'Jag körde GSC URL Inspection i noVNC-Firefoxen och postade observationen i kanalen.'
    : `Kunde inte öppna GSC UI: ${result.error || result.status || 'okänt fel'}`
}

async function findActionForWorkspace(actionId, targetChannelId) {
  const workspace = workspaceForChannel(targetChannelId)
  const payload = await fetchActionsForChat(workspace)
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  return actions.find((item) => String(item.id || '') === String(actionId))
    || fallbackActionFromState(actionId, targetChannelId, workspace)
    || await findAction(actionId).catch(() => null)
}

async function saveActionDecision({ actionId, decision, reason, source, discordMessageId, discordChannelId }) {
  return fetchPlatformJson(`/api/platform/seo-monitor/actions/${encodeURIComponent(actionId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision,
      reason,
      source,
      operatorId: `discord:${allowedUserId}`,
      metadata: {
        discordMessageId,
        discordChannelId,
      }
    })
  })
}

async function handleChatMessage(content, message, targetChannelId) {
  const trimmed = content.trim()
  if (!trimmed || trimmed.length < 2) return
  if (/google ads.*oauth|ads oauth|keyword planner.*oauth|google ads.*login/i.test(trimmed)) {
    await sendDiscordMessage(formatGoogleAdsOauthStartMessage(), targetChannelId)
    return
  }
  if (/^(doctor|integrations?|integration doctor|status integrations?)$/i.test(trimmed)) {
    const workspaces = await listWorkspaces().catch(() => [])
    const report = await buildIntegrationDoctorReport(workspaces)
    await sendDiscordMessage(formatIntegrationDoctorMessage(report, false), targetChannelId)
    return
  }
  if (/^(agent doctor|agent brain|struktur|structure)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    await sendDiscordMessage(formatAgentBrainStatus(workspace), targetChannelId)
    return
  }
  if (/^(health|hälsa|halsa|agent health|drift)$/i.test(trimmed)) {
    await sendDiscordMessage(formatAgentHealthReport(), targetChannelId)
    return
  }
  if (/^(gsc browser doctor|gsc browser|browser doctor)$/i.test(trimmed)) {
    await sendDiscordMessage(await formatGscBrowserDoctorMessage(), targetChannelId)
    return
  }
  if (/^(gsc ui doctor|gsc firefox doctor|firefox doctor)$/i.test(trimmed)) {
    await sendDiscordMessage(await formatGscFirefoxUiDoctorMessage(), targetChannelId)
    return
  }
  if (/gsc.*oauth|search console.*oauth|gsc.*login|search console.*login/i.test(trimmed)) {
    await sendDiscordMessage(await formatGscOauthStartMessage(), targetChannelId)
    return
  }
  const googleAdsCode = extractGoogleAdsOauthCode(trimmed)
  if (googleAdsCode) {
    await handleGoogleAdsOauthCode(googleAdsCode, message, targetChannelId)
    return
  }
  if (/^(status|hjälp|help)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    const actions = await fetchActionsForChat(workspace)
    await sendDiscordMessage(formatStatusMessage(workspace, actions), targetChannelId)
    return
  }
  if (/^(mål|mal|workspace mål|workspace mal|goals?)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    await sendDiscordMessage(formatWorkspaceProfileMessage(workspace, targetChannelId), targetChannelId)
    return
  }
  if (/^(lärdomar|lardomar|lessons?|minne|memory|ledger)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    await sendDiscordMessage(formatActionLedgerSummary(workspace, targetChannelId), targetChannelId)
    return
  }
  if (/^(commits?|kodhistorik|kod history|code history)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    await sendDiscordMessage(formatCodeActionHistory(workspace), targetChannelId)
    return
  }
  if (/^(codex usage|codex kostnad|token usage|tokens|usage)$/i.test(trimmed)) {
    await sendDiscordMessage(formatCodexUsageSummary(), targetChannelId)
    return
  }
  if (/^(vilket|vilket kort\??|visa kort(et)?\??|skicka kort(et)? igen\??|posta kort(et)? igen\??|nästa steg\??|nasta steg\??|vad är nästa steg\??|vad ar nasta steg\??)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    const actions = await fetchActionsForChat(workspace)
    const posted = await repostActiveActionCard(workspace, actions, targetChannelId, { intro: /nästa|nasta/i.test(trimmed) ? 'Nästa steg är det här kortet:' : 'Här är kortet jag menar:' })
    if (!posted) await sendDiscordMessage(formatGeneralChatFallback(workspace, actions, targetChannelId, workspaceGuidanceFor(workspace, targetChannelId)), targetChannelId)
    return
  }
  if (/\b(indexerad|indexerat|finns i index|är i google|ar i google)\b/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    const handled = await handleUserIndexingConfirmation(workspace, targetChannelId, trimmed)
    if (handled) return
  }
  const operatorIntentHandled = await maybeHandleOperatorIntent(trimmed, targetChannelId).catch((error) => {
    log('operator_intent_failed', { channelId: targetChannelId, error: error?.message || String(error) })
    return false
  })
  if (operatorIntentHandled) return
  if (/gsc|search console|koppling|oauth/i.test(trimmed)) {
    await sendDiscordMessage('GSC kopplas i Dashboard2 -> SEO Monitor -> Integrations -> Google Search Console. Skriv `gsc oauth` här så postar jag kopplingslänken. Om OAuth/token fallerar behandlar jag det som integrationsfel, inte som content-commit.', targetChannelId)
    return
  }
  const workspace = workspaceForChannel(targetChannelId)
  const guidance = shouldRememberWorkspaceGuidance(trimmed) ? rememberWorkspaceGuidance(workspace, targetChannelId, trimmed) : workspaceGuidanceFor(workspace, targetChannelId)
  const actions = await fetchActionsForChat(workspace)
  const reply = await formatWorkspaceLlmChat({ workspace, payload: actions, targetChannelId, guidance, message: trimmed }).catch((error) => {
    log('workspace_llm_chat_failed', { workspace: workspace?.label || workspace?.id || null, error: error?.message || String(error) })
    return formatGeneralChatFallback(workspace, actions, targetChannelId, guidance)
  })
  await sendDiscordMessage(reply, targetChannelId)
}

async function maybeHandleOperatorIntent(message, targetChannelId) {
  if (!codexChatEnabled) return false
  const workspace = workspaceForChannel(targetChannelId)
  if (!workspace) return false
  const payload = await fetchActionsForChat(workspace)
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const activeRecord = activeActionRecordFor(workspace, targetChannelId)
  const activeId = activeRecord?.actionId || null
  const active = activeId ? actions.find((item) => String(item.id || '') === String(activeId)) : null
  if (!active) return false
  if (!isIndexingCheckAction(active) && !/klar|klart|fixad|fixat|gjord|gjort|hanterad|hanterat|index|google|vänta|vanta|irrelevant|skippa|hoppa/i.test(message)) return false
  const intent = await runCodexOperatorIntent({ workspace, activeAction: compactActionForChat(active), message })
  if (intent.intent === 'confirm_indexed' && isIndexingCheckAction(active)) {
    await handleUserIndexingConfirmation(workspace, targetChannelId, message)
    return true
  }
  if (intent.intent === 'mark_handled') {
    await saveActionDecision({
      actionId: active.id,
      decision: 'skipped',
      reason: `User confirmed handled in Discord: ${String(message || '').slice(0, 240)}`,
      source: 'discord_operator_intent',
      discordMessageId: null,
      discordChannelId: targetChannelId
    })
    clearActiveAction(active.id)
    saveState()
    await sendDiscordMessage(`Jag markerade kortet som hanterat: ${active.title || active.id}`, targetChannelId)
    return true
  }
  if (intent.intent === 'deprioritize') {
    await saveActionDecision({
      actionId: active.id,
      decision: 'deprioritized',
      reason: `User deprioritized in natural language: ${String(message || '').slice(0, 240)}`,
      source: 'discord_operator_intent',
      discordMessageId: null,
      discordChannelId: targetChannelId
    })
    clearActiveAction(active.id)
    saveState()
    await sendDiscordMessage(`Jag prioriterade bort kortet tills vidare: ${active.title || active.id}`, targetChannelId)
    return true
  }
  return false
}

async function runCodexOperatorIntent(context) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const promptPath = join(stateDir, 'codex-operator-intent.md')
  const prompt = [
    'Du är SEO Agentens intentklassare. Tolka användarens svenska Discord-meddelande mot aktivt action-kort.',
    'Returnera ENDAST JSON: {"intent":"none|confirm_indexed|mark_handled|deprioritize","reason":"kort"}',
    '',
    'confirm_indexed = användaren säger att URL:en/sidan redan är indexerad, finns i Google eller att indexeringskortet är löst.',
    'mark_handled = användaren säger att aktiv action är klar/fixad/hanterad men inte specifikt indexering.',
    'deprioritize = användaren säger att den ska vänta, inte är relevant nu, eller ska prioriteras bort.',
    'none = fråga, diskussion, osäkerhet eller saknar tydligt beslut.',
    '',
    'AGENT SPEC:',
    readAgentSpecs(),
    '',
    'CONTEXT JSON:',
    JSON.stringify(context, null, 2)
  ].join('\n')
  writeFileSync(promptPath, prompt)
  const result = await execCodexTracked({
    agent: 'seo-agent',
    purpose: 'operator_intent',
    workspace: context?.workspace?.label || context?.workspace?.id || null,
    command: `codex exec --json --cd /home/deploy/seo-agent-discord --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`,
    timeout: 2 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024
  })
  const text = extractCodexExecText(result.stdout || '')
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text)
  const intent = ['none', 'confirm_indexed', 'mark_handled', 'deprioritize'].includes(parsed.intent) ? parsed.intent : 'none'
  return { intent, reason: String(parsed.reason || '').slice(0, 240) }
}

async function handleUserIndexingConfirmation(workspace, targetChannelId, message) {
  const payload = await fetchActionsForChat(workspace)
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const activeKey = activeWorkspaceActionKey(workspace, targetChannelId)
  const activeId = state.activeActionByWorkspace?.[activeKey]?.actionId || null
  const action = (activeId ? actions.find((item) => String(item.id || '') === String(activeId)) : null)
    || actions.find((item) => isIndexingCheckAction(item))
  if (!action || !isIndexingCheckAction(action)) return false
  await saveActionDecision({
    actionId: action.id,
    decision: 'skipped',
    reason: `User confirmed indexed in Discord: ${String(message || '').slice(0, 240)}`,
    source: 'discord_indexing_confirmation',
    discordMessageId: null,
    discordChannelId: targetChannelId
  })
  clearActiveAction(action.id)
  state.indexingConfirmations = state.indexingConfirmations || {}
  state.indexingConfirmations[`${workspace?.label || workspace?.id || 'workspace'}:${normalizeActionPath(action.targetUrl || '')}`] = {
    status: 'indexed',
    actionId: action.id,
    confirmedAt: new Date().toISOString(),
    source: 'user_discord'
  }
  saveState()
  await sendDiscordMessage([
    `Jag markerade indexeringskortet som hanterat för ${workspace?.label || workspace?.id || 'workspace'}.`,
    action.targetUrl ? `URL: ${action.targetUrl}` : '',
    'Jag går vidare till nästa SEO-action och väntar på ny GSC-data innan jag tar upp indexering igen.'
  ].filter(Boolean).join('\n'), targetChannelId)
  return true
}

async function formatWorkspaceLlmChat({ workspace, payload, targetChannelId, guidance, message }) {
  if (!codexChatEnabled) return formatGeneralChatFallback(workspace, payload, targetChannelId, guidance)
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const activeRecord = activeActionRecordFor(workspace, targetChannelId)
  const activeId = activeRecord?.actionId || null
  const active = activeId ? actions.find((item) => item.id === activeId) : null
  const ledgerFallbackActions = ledgerActionsForWorkspace(workspace, targetChannelId).slice(0, 8)
  const pending = actions.filter((item) => item.status === 'pending').slice(0, 8)
  const chatActions = pending.length ? pending : ledgerFallbackActions
  const context = {
    workspace: workspace ? {
      id: workspace.id,
      label: workspace.label,
      gscProperty: workspace.gscProperty,
      repoFullName: workspace.repoFullName,
      branch: workspace.branch || 'main'
    } : null,
    automation: { codeAutomationEnabled, codexChatEnabled, activeActionId: activeId },
    workspaceGoals: payload.workspaceGoals || null,
    workspacePolicy: payload.workspacePolicy || null,
    savedGuidance: guidance || workspaceGuidanceFor(workspace, targetChannelId),
    dataStatus: {
      actionsFetchError: payload.error || null,
      resourceLimitFallback: payload.resourceLimitFallback || null,
      actionCount: actions.length,
      ledgerFallbackCount: ledgerFallbackActions.length
    },
    activeAction: active ? compactActionForChat(active) : null,
    pendingActions: chatActions.map(compactActionForChat),
    ledgerFallbackActions: ledgerFallbackActions.map(compactActionForChat),
    userMessage: message
  }
  return runCodexWorkspaceChat(context).catch((error) => {
    log('workspace_codex_chat_failed', { workspace: workspace?.label || workspace?.id || null, error: error?.message || String(error) })
    return formatGeneralChatFallback(workspace, payload, targetChannelId, guidance)
  })
}

async function runCodexWorkspaceChat(context) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const promptPath = join(stateDir, 'codex-chat-prompt.md')
  const prompt = [
    'Du är SEO Agent i Discord/Hermes. Svara på svenska som en praktisk senior SEO/kod-agent.',
    'Du kan ha vanlig konversation och strategiskt resonemang, men håll svaret konkret.',
    'Du är inte bara en kommandobot. Om användaren frågar vad som är smart ska du resonera utifrån mål, workspace-policy, kö, repo och datastatus.',
    'Använd workspace-kontexten. Om användaren ger riktning, bekräfta vad du sparar och hur det ändrar prioritering.',
    'Om befintlig kö inte matchar användarens riktning, säg det tydligt och föreslå att skapa research/new-page-action eller deprioritera fel action.',
    'Om CONTEXT JSON visar actionsFetchError eller resourceLimitFallback: säg kort att live-datakällan är begränsad, men använd ledgerFallbackActions/pendingActions för konkret nästa steg.',
    'Om pendingActions kommer från ledgerFallbackActions: säg inte att det saknas approve-ready action. Välj bästa ledger-kortet eller säg att det är ett minneskort som kan behöva repost/approve.',
    'Om pendingActions är tom men användaren frågar om nästa steg: föreslå en konkret SEO-riktning och säg vilken integration/datadel som behöver friskna till.',
    'Säg inte att du är i pilotläge. Kodautomation är aktiv om context.automation.codeAutomationEnabled är true.',
    'Du får inte låtsas att du har kört kod eller skickat mail. Föreslå approve/skip/deprioritize när det är relevant.',
    'Inkludera max ett konkret kommando, t.ex. approve <id> eller deprioritize <id>, om ett kort bör ageras.',
    '',
    'AGENT SPEC:',
    readAgentSpecs(),
    '',
    'CONTEXT JSON:',
    JSON.stringify(context, null, 2)
  ].join('\n')
  writeFileSync(promptPath, prompt)
  const result = await execCodexTracked({
    agent: 'seo-agent',
    purpose: 'workspace_chat',
    workspace: context?.workspace?.label || context?.workspace?.id || null,
    command: `codex exec --json --cd /home/deploy/seo-agent-discord --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`,
    timeout: 4 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024
  })
  const output = extractCodexExecText(result.stdout || '')
  return (output || 'Jag kunde inte formulera ett Codex-svar just nu. Skriv `status` för kö eller använd approve/skip/deprioritize.').slice(0, 1900)
}

function extractCodexExecText(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
  const texts = []
  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      if (typeof event.output_text === 'string') texts.push(event.output_text)
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') texts.push(event.item.text)
      if (typeof event.text === 'string' && /message|response|final|agent/i.test(String(event.type || ''))) texts.push(event.text)
      if (typeof event.message === 'string' && event.type && /message|response|final/i.test(String(event.type))) texts.push(event.message)
      if (Array.isArray(event.output)) {
        for (const item of event.output) {
          for (const content of item.content || []) if (typeof content.text === 'string') texts.push(content.text)
        }
      }
    } catch {}
  }
  if (texts.length) return texts[texts.length - 1].trim()
  return ''
}

async function execCodexTracked({ agent, purpose, workspace, command, timeout, maxBuffer }) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const startedAt = Date.now()
  try {
    const result = await exec('bash', ['-lc', command], {
      cwd: '/home/deploy/seo-agent-discord',
      env: { ...process.env, PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}` },
      timeout,
      maxBuffer
    })
    recordCodexUsage({ agent, purpose, workspace, status: 'ok', durationMs: Date.now() - startedAt, stdout: result.stdout || '' })
    return result
  } catch (error) {
    recordCodexUsage({ agent, purpose, workspace, status: 'failed', durationMs: Date.now() - startedAt, stdout: error?.stdout || '', error: error?.message || String(error) })
    throw error
  }
}

function recordCodexUsage({ agent = 'unknown', purpose = 'unknown', workspace = null, status = 'unknown', durationMs = 0, stdout = '', error = null }) {
  const usage = extractCodexUsage(stdout)
  const day = new Date().toISOString().slice(0, 10)
  state.codexUsage = state.codexUsage || {}
  state.codexUsage[day] = state.codexUsage[day] || { total: emptyCodexUsageBucket(), byAgent: {}, byPurpose: {}, byWorkspace: {} }
  addCodexUsage(state.codexUsage[day].total, usage, status, durationMs)
  addCodexUsage(state.codexUsage[day].byAgent[agent] ||= emptyCodexUsageBucket(), usage, status, durationMs)
  addCodexUsage(state.codexUsage[day].byPurpose[purpose] ||= emptyCodexUsageBucket(), usage, status, durationMs)
  if (workspace) addCodexUsage(state.codexUsage[day].byWorkspace[workspace] ||= emptyCodexUsageBucket(), usage, status, durationMs)
  saveState()
  appendCodexUsageLog({ at: new Date().toISOString(), day, agent, purpose, workspace, status, durationMs, usage, error, stateRecorded: true })
  log('codex_usage_recorded', { agent, purpose, workspace, status, ...usage, durationMs })
}

function extractCodexUsage(stdout) {
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, calls: 1 }
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      const raw = event.usage || event.response?.usage || event.item?.usage || null
      if (!raw || typeof raw !== 'object') continue
      usage.inputTokens += Number(raw.input_tokens || raw.inputTokens || 0)
      usage.cachedInputTokens += Number(raw.cached_input_tokens || raw.cachedInputTokens || raw.input_tokens_details?.cached_tokens || 0)
      usage.outputTokens += Number(raw.output_tokens || raw.outputTokens || 0)
      usage.reasoningOutputTokens += Number(raw.reasoning_output_tokens || raw.reasoningOutputTokens || raw.output_tokens_details?.reasoning_tokens || 0)
    } catch {}
  }
  return usage
}

function emptyCodexUsageBucket() {
  return { calls: 0, failed: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, durationMs: 0 }
}

function addCodexUsage(bucket, usage, status, durationMs) {
  bucket.calls += 1
  if (status !== 'ok') bucket.failed += 1
  bucket.inputTokens += usage.inputTokens || 0
  bucket.cachedInputTokens += usage.cachedInputTokens || 0
  bucket.outputTokens += usage.outputTokens || 0
  bucket.reasoningOutputTokens += usage.reasoningOutputTokens || 0
  bucket.durationMs += durationMs || 0
}

function appendCodexUsageLog(entry) {
  try {
    appendFileSync(join(stateDir, 'codex-usage.jsonl'), `${JSON.stringify(entry)}\n`)
    mkdirSync('/home/deploy/agent-usage', { recursive: true })
    appendFileSync('/home/deploy/agent-usage/codex-usage.jsonl', `${JSON.stringify(entry)}\n`)
  } catch (error) {
    log('codex_usage_log_failed', { error: error?.message || String(error) })
  }
}

function formatCodexUsageSummary(day = new Date().toISOString().slice(0, 10)) {
  const summary = mergeCodexUsageSummary(day)
  if (!summary) return `Ingen Codex-usage loggad för ${day} ännu.`
  const lines = [`Codex usage ${day}`, formatCodexBucket('Totalt', summary.total)]
  lines.push('', 'Per purpose:')
  for (const [key, bucket] of Object.entries(summary.byPurpose || {}).sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens))) {
    lines.push(formatCodexBucket(key, bucket))
  }
  if (Object.keys(summary.byWorkspace || {}).length) {
    lines.push('', 'Per workspace:')
    for (const [key, bucket] of Object.entries(summary.byWorkspace || {}).sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens))) {
      lines.push(formatCodexBucket(key, bucket))
    }
  }
  return lines.join('\n').slice(0, 1900)
}

function mergeCodexUsageSummary(day) {
  const base = state.codexUsage?.[day]
    ? JSON.parse(JSON.stringify(state.codexUsage[day]))
    : { total: emptyCodexUsageBucket(), byAgent: {}, byPurpose: {}, byWorkspace: {} }
  let found = Boolean(state.codexUsage?.[day])
  const usagePath = join(stateDir, 'codex-usage.jsonl')
  if (!existsSync(usagePath)) return found ? base : null
  for (const line of readFileSync(usagePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry.stateRecorded) continue
      if (String(entry.day || entry.at || '').slice(0, 10) !== day) continue
      const usage = entry.usage || {}
      const status = entry.status || 'ok'
      const durationMs = Number(entry.durationMs || 0)
      const agent = entry.agent || 'unknown'
      const purpose = entry.purpose || 'unknown'
      const workspace = entry.workspace || null
      addCodexUsage(base.total, usage, status, durationMs)
      addCodexUsage(base.byAgent[agent] ||= emptyCodexUsageBucket(), usage, status, durationMs)
      addCodexUsage(base.byPurpose[purpose] ||= emptyCodexUsageBucket(), usage, status, durationMs)
      if (workspace) addCodexUsage(base.byWorkspace[workspace] ||= emptyCodexUsageBucket(), usage, status, durationMs)
      found = true
    } catch {}
  }
  return found ? base : null
}

function formatCodexBucket(label, bucket) {
  const totalTokens = Number(bucket.inputTokens || 0) + Number(bucket.outputTokens || 0)
  const cached = bucket.cachedInputTokens ? `, cached ${bucket.cachedInputTokens}` : ''
  const reasoning = bucket.reasoningOutputTokens ? `, reasoning ${bucket.reasoningOutputTokens}` : ''
  return `${label}: ${bucket.calls} calls, ${bucket.failed} failed, ${totalTokens} tokens (in ${bucket.inputTokens}${cached}, out ${bucket.outputTokens}${reasoning})`
}


function compactActionForChat(action) {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    priority: action.priority,
    priorityScore: action.priorityScore,
    confidence: action.confidence,
    category: action.category,
    targetUrl: action.targetUrl,
    keyword: action.keyword,
    why: action.why,
    recommendedAction: action.recommendedAction,
    priorityReason: action.priorityReason
  }
}

function extractOpenAiResponseText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text.trim()
  const chunks = []
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') chunks.push(content.text)
    }
  }
  return chunks.join('\n').trim()
}

function readAgentSpecs() {
  const parts = []
  for (const file of agentSpecFiles) {
    const path = join('/home/deploy/seo-agent-discord', file)
    if (!existsSync(path)) continue
    try {
      parts.push(`## ${file}\n${readFileSync(path, 'utf8').slice(0, 4000)}`)
    } catch {}
  }
  return parts.join('\n\n') || 'No local agent spec files found.'
}

function rememberWorkspaceGuidance(workspace, targetChannelId, message) {
  const key = activeWorkspaceActionKey(workspace, targetChannelId)
  const focusTerms = extractWorkspaceFocusTerms(message)
  state.workspaceGuidance = state.workspaceGuidance || {}
  const existing = state.workspaceGuidance[key] || { notes: [], focusTerms: [] }
  const nextTerms = [...new Set([...(existing.focusTerms || []), ...focusTerms])].slice(0, 30)
  const nextNotes = [
    { text: message.slice(0, 600), at: new Date().toISOString() },
    ...(existing.notes || [])
  ].slice(0, 20)
  const guidance = { ...existing, focusTerms: nextTerms, notes: nextNotes, updatedAt: new Date().toISOString() }
  state.workspaceGuidance[key] = guidance
  saveState()
  return guidance
}

function workspaceGuidanceFor(workspace, targetChannelId) {
  const key = activeWorkspaceActionKey(workspace, targetChannelId)
  return state.workspaceGuidance?.[key] || null
}

function shouldRememberWorkspaceGuidance(message) {
  const text = String(message || '').toLowerCase()
  if (/\b(status|commits?|kodhistorik|doctor|why|nästa steg|nasta steg|vad händer|vad hander)\b/i.test(text)) return false
  return extractWorkspaceFocusTerms(message).length > 0 && /\b(fokus|fokusera|prioritera|deprioritera|mål|mal|rikta|satsa|mer på|mindre på|vill|borde)\b/i.test(text)
}

function extractWorkspaceFocusTerms(message) {
  const normalized = String(message || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
  const explicit = []
  const known = [
    'ai utbildning', 'ai agent', 'ai agenter', 'ai automatisering', 'ai', 'automation', 'automatisering',
    'kodning', 'kod', 'utbildning', 'kurs', 'workshop', 'webb', 'app', 'apputveckling',
    'internverktyg', 'crm', 'faktura', 'bokforing', 'integration', 'events', 'startup',
    'entreprenor', 'natverk', 'parkering'
  ]
  for (const term of known) if (normalized.includes(term)) explicit.push(term)
  return [...new Set(explicit)].slice(0, 12)
}

async function repostActiveActionCard(workspace, payload, targetChannelId, options = {}) {
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const activeKey = activeWorkspaceActionKey(workspace, targetChannelId)
  const activeRecord = activeActionRecordFor(workspace, targetChannelId)
  const activeId = activeRecord?.actionId || null
  const action = (activeId ? actions.find((item) => String(item.id || '') === String(activeId)) : null)
    || actions.find((item) => item.status === 'pending')
  if (!action?.id) return null
  const enrichedAction = await enrichActionWithKeywordMetrics(action)
  const message = [
    options.intro || 'Här är kortet jag menar:',
    formatActionMessage(enrichedAction, payload.workspacePolicy, workspace)
  ].join('\n\n')
  const posted = await sendDiscordMessage(message, targetChannelId, actionComponents(enrichedAction))
  state.postedActionIds = state.postedActionIds || {}
  state.postedActionIds[action.id] = {
    ...(state.postedActionIds[action.id] || {}),
    messageId: posted.id,
    channelId: targetChannelId,
    title: enrichedAction.title || '',
    workspaceId: workspace?.id || null,
    repostedAt: new Date().toISOString()
  }
  state.activeActionByWorkspace = state.activeActionByWorkspace || {}
  state.activeActionByWorkspace[activeKey] = {
    ...(activeRecord || {}),
    actionId: action.id,
    messageId: posted.id,
    channelId: targetChannelId,
    workspaceId: workspace?.id || null,
    firstPostedAt: activeRecord?.firstPostedAt || activeRecord?.postedAt || new Date().toISOString(),
    postedAt: new Date().toISOString(),
    reposted: true
  }
  state.messageToAction = state.messageToAction || {}
  state.messageToAction[posted.id] = action.id
  saveState()
  return posted
}

function discordMessageUrl(targetChannelId, messageId) {
  if (!targetChannelId || !messageId) return ''
  return `https://discord.com/channels/${guildId || '@me'}/${targetChannelId}/${messageId}`
}

function formatGeneralChatFallback(workspace, payload, targetChannelId, guidance = null) {
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const activeRecord = activeActionRecordFor(workspace, targetChannelId)
  const activeId = activeRecord?.actionId || null
  const active = activeId ? actions.find((item) => item.id === activeId) : null
  const ledgerFallback = ledgerActionsForWorkspace(workspace, targetChannelId)
  const next = active || actions.find((item) => item.status === 'pending') || actions[0] || ledgerFallback[0]
  const label = workspace?.label || workspace?.id || 'workspace'
  const cardUrl = activeRecord?.messageId ? discordMessageUrl(activeRecord.channelId || targetChannelId, activeRecord.messageId) : ''
  if (!next && activeRecord?.actionId) {
    return [
      `Nästa steg för ${label}: jag väntar fortfarande på beslut på det aktiva kortet.`,
      `Kort-ID: \`${activeRecord.actionId}\``,
      cardUrl ? `Kort: ${cardUrl}` : 'Kort: skriv `vilket kort?` så postar jag det igen med knappar.',
      'Jag hittar inte kortet i senaste topp-listan från SEO Monitor, men det är fortfarande markerat som aktivt i agentens kö. Approve/Skip/Deprioritize på kortet löser kön.'
    ].join('\n').slice(0, 1900)
  }
  if (!next) return `Nästa steg för ${label}: jag hittar ingen pending SEO-action just nu. Kör \`status\` för kö eller \`doctor\` om du vill kontrollera integrationer.`
  const why = next.priorityReason || next.why || 'Den ligger högst i aktuell SEO-kö.'
  return [
    `Nästa steg för ${label}: ${next.title}.`,
    cardUrl ? `Kort: ${cardUrl}` : 'Kort: skriv `vilket kort?` så postar jag det igen med knappar.',
    `Varför: ${String(why).slice(0, 260)}`,
    'Jag väntar på ditt beslut på kortet: Approve om du vill att jag kodar den, Skip om den är irrelevant, Deprioritize om den kan vänta.',
    'Vill du se vad som redan skapats: skriv `commits`.'
  ].join('\n').slice(0, 1900)
}

function activeActionRecordFor(workspace, targetChannelId) {
  const active = state.activeActionByWorkspace || {}
  const exactKey = activeWorkspaceActionKey(workspace, targetChannelId)
  if (active[exactKey]) return active[exactKey]
  const workspaceKeys = new Set([
    workspace?.id,
    workspace?.gscProperty,
    workspace?.repoFullName,
    slugify(workspace?.label || ''),
    targetChannelId
  ].filter(Boolean).map(String))
  for (const record of Object.values(active)) {
    if (!record) continue
    if (targetChannelId && String(record.channelId || '') === String(targetChannelId)) return record
    if (record.workspaceId && workspaceKeys.has(String(record.workspaceId))) return record
  }
  return null
}

async function formatGscFirefoxUiDoctorMessage() {
  const result = await runGscFirefoxUiTool({ command: 'doctor' }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  return [
    'GSC Firefox UI tool',
    `Status: ${result.ok ? 'redo' : 'inte redo'}`,
    result.container ? `Container: ${result.container}` : '',
    result.mode ? `Mode: ${result.mode}` : '',
    result.error ? `Fel: ${result.error}` : '',
    'Detta styr den inloggade noVNC-Firefoxen. Används för GSC-flöden som Google blockerar i Selenium.'
  ].filter(Boolean).join('\n')
}

async function runGscFirefoxUiTool(input) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const inputPath = join(stateDir, 'gsc-firefox-ui-input.json')
  writeFileSync(inputPath, JSON.stringify(input, null, 2))
  const result = await exec('/usr/bin/node', ['/home/deploy/seo-agent-discord/gsc-firefox-ui-tool.mjs', inputPath], {
    cwd: '/home/deploy/seo-agent-discord',
    env: { ...process.env, PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}` },
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024
  })
  return JSON.parse(result.stdout || '{}')
}

async function formatGscBrowserDoctorMessage() {
  const result = await runGscBrowserTool({ command: 'doctor' }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  return [
    'GSC browser tool',
    `Status: ${result.ok ? 'redo' : 'inte redo'}`,
    result.browser?.package ? `Browser: ${result.browser.package}` : '',
    result.profileDir ? `Profil: ${result.profileDir}` : '',
    result.error ? `Fel: ${result.error}` : '',
    Array.isArray(result.notes) && result.notes.length ? `Notis: ${result.notes.join(' ')}` : '',
    'För indexering krävs en inloggad Search Console-session i profilen och verifierad property-access.'
  ].filter(Boolean).join('\n').slice(0, 1900)
}

async function runGscBrowserTool(input) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const inputPath = join(stateDir, 'gsc-browser-input.json')
  writeFileSync(inputPath, JSON.stringify(input, null, 2))
  const result = await exec('/usr/bin/node', ['/home/deploy/seo-agent-discord/gsc-browser-tool.mjs', inputPath], {
    cwd: '/home/deploy/seo-agent-discord',
    env: { ...process.env, PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}` },
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024
  })
  return JSON.parse(result.stdout || '{}')
}

async function formatGscOauthStartMessage() {
  try {
    const payload = await fetchPlatformJson('/api/platform/integrations/gsc/start', {
      method: 'POST',
      body: JSON.stringify({ returnTo: 'https://dashboard2.sebcastwall.se/#/growth/seo-monitor' })
    })
    if (payload.authorizationUrl) {
      return [
        'Google Search Console OAuth: öppna länken och koppla om GSC.',
        payload.authorizationUrl,
        '',
        'När flödet är klart kör `doctor` här för att verifiera.'
      ].join('\n')
    }
    return `GSC OAuth kunde inte starta: ${JSON.stringify(payload).slice(0, 500)}`
  } catch (error) {
    return `GSC OAuth kunde inte starta: ${error?.message || String(error)}`
  }
}

function formatGoogleAdsOauthStartMessage() {
  const authUrl = googleAdsOauthUrl()
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET) {
    return [
      'Google Ads OAuth kan inte starta: SEO-agenten saknar GOOGLE_ADS_CLIENT_ID eller GOOGLE_ADS_CLIENT_SECRET på VPS:en.',
      'Codex behöver synka Ads-modulens OAuth client till agentens env först.'
    ].join('\n')
  }
  return [
    'Google Ads OAuth: öppna länken, logga in med kontot som har Google Ads-access och godkänn.',
    authUrl,
    '',
    'Efteråt kan browsern hamna på localhost och visa fel. Det är okej: kopiera hela URL:en från adressfältet eller bara `code=...` och klistra in här.',
    'Agenten skriver aldrig ut refresh token i Discord.'
  ].join('\n')
}

function googleAdsOauthUrl() {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_ADS_CLIENT_ID || '',
    redirect_uri: googleAdsOauthRedirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline',
    prompt: 'consent',
    state: googleAdsOauthState
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

function extractGoogleAdsOauthCode(content) {
  const direct = content.match(/(?:^|\s)(?:google ads code|ads code|code)[:=\s]+([A-Za-z0-9._~+-]+)/i)
  if (direct?.[1]) return direct[1]
  try {
    const url = new URL(content.match(/https?:\/\/\S+/)?.[0] || content)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state === googleAdsOauthState) return code
  } catch {}
  return null
}

async function handleGoogleAdsOauthCode(code, message, targetChannelId) {
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET) {
    await sendDiscordMessage('Kan inte växla Google Ads-koden: OAuth client saknas i agentens env.', targetChannelId)
    return
  }
  try {
    const token = await exchangeGoogleAdsOauthCode(code)
    if (!token.refreshToken) {
      await sendDiscordMessage('Google svarade utan refresh token. Kör `google ads oauth` igen och se till att du godkänner med `prompt=consent`.', targetChannelId)
      return
    }
    saveGoogleAdsRefreshToken(token.refreshToken)
    await sendDiscordMessage([
      'Google Ads OAuth lyckades. Ny refresh token är sparad lokalt på VPS:en.',
      'Codex uppdaterar nu Cloudflare secret `GOOGLE_ADS_REFRESH_TOKEN` och testar Keyword Planner igen.'
    ].join('\n'), targetChannelId)
    log('google_ads_oauth_refresh_token_saved', { discordMessageId: message.id, channelId: targetChannelId })
  } catch (error) {
    await sendDiscordMessage(`Google Ads OAuth misslyckades: ${error?.message || String(error)}`, targetChannelId)
  }
}

async function exchangeGoogleAdsOauthCode(code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_ADS_CLIENT_ID || '',
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET || '',
      redirect_uri: googleAdsOauthRedirectUri,
      grant_type: 'authorization_code'
    })
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error_description || payload.error || `google_oauth_${response.status}`)
  return {
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : '',
    accessToken: payload.access_token ? String(payload.access_token) : ''
  }
}

function saveGoogleAdsRefreshToken(refreshToken) {
  const tokenPath = join(stateDir, 'google-ads-refresh-token.txt')
  writeFileSync(tokenPath, refreshToken, { mode: 0o600 })
}

async function fetchActionsForChat(workspace) {
  return fetchSeoMonitorActions(workspace, 12).catch((error) => ({ error: error?.message || String(error), actions: [] }))
}

async function fetchSeoMonitorActions(workspace, limit) {
  const activeFallback = activeSeoActionsResourceLimitFallback(workspace)
  const preferRepoOnlyRoute = shouldPreferRepoOnlySeoActionsRoute(workspace)
  if (activeFallback || preferRepoOnlyRoute) {
    const fallbackLimit = activeFallback ? 1 : Math.min(Number(limit) || 3, 3)
    try {
      const payload = await fetchPlatformJson(buildSeoMonitorActionsPath(workspace, fallbackLimit, { includeGscProperty: false }))
      return activeFallback
        ? payload
        : {
            ...payload,
            resourceLimitFallback: {
              route: 'repo_only',
              originalLimit: limit,
              fallbackLimit,
              reason: 'sc_domain_repo_route'
            }
          }
    } catch (fallbackError) {
      if (isPlatformResourceLimitError(fallbackError)) {
        rememberSeoActionsResourceLimitFallback(workspace, fallbackError, 30 * 60 * 1000)
        logThrottled(`seo_actions_repo_only_resource_limit:${seoActionsResourceLimitFallbackKey(workspace)}`, 15 * 60 * 1000, 'seo_actions_repo_only_resource_limit', {
          workspace: workspace.label || workspace.id || workspace.repoFullName,
          limit: fallbackLimit,
          error: fallbackError?.message || String(fallbackError)
        })
        if (fallbackLimit > 1) {
          const minimalPayload = await fetchPlatformJson(buildSeoMonitorActionsPath(workspace, 1, { includeGscProperty: false })).catch(() => null)
          if (minimalPayload) {
            return {
              ...minimalPayload,
              resourceLimitFallback: {
                route: 'repo_only_minimal',
                originalLimit: limit,
                fallbackLimit: 1,
                originalError: fallbackError?.message || String(fallbackError),
                suppressedUntil: state.seoActionsResourceLimitFallbacks?.[seoActionsResourceLimitFallbackKey(workspace)]?.until || null
              }
            }
          }
        }
        return { actions: [], resourceLimitFallback: { route: 'repo_only', originalLimit: limit, fallbackLimit, originalError: fallbackError?.message || String(fallbackError), suppressedUntil: state.seoActionsResourceLimitFallbacks?.[seoActionsResourceLimitFallbackKey(workspace)]?.until || null } }
      }
      if (activeFallback) clearSeoActionsResourceLimitFallback(workspace)
      if (!preferRepoOnlyRoute) throw fallbackError
      log('seo_actions_repo_only_preferred_route_failed', {
        workspace: workspace.label || workspace.id || workspace.repoFullName,
        limit,
        error: fallbackError?.message || String(fallbackError)
      })
    }
  }
  try {
    const payload = await fetchPlatformJson(buildSeoMonitorActionsPath(workspace, limit))
    clearSeoActionsResourceLimitFallback(workspace)
    return payload
  } catch (error) {
    if (isSeoBatchNotFoundError(error)) return emptySeoActionsForMissingBatch(workspace, error)
    if (!workspace?.repoFullName || !workspace?.gscProperty || !isPlatformResourceLimitError(error)) throw error
    const fallbackLimit = Math.min(Number(limit) || 3, 3)
    const fallbackPath = buildSeoMonitorActionsPath(workspace, fallbackLimit, { includeGscProperty: false })
    log('seo_actions_resource_limit_fallback', {
      workspace: workspace.label || workspace.id || workspace.repoFullName,
      originalLimit: limit,
      fallbackLimit,
      route: 'repo_only',
      error: error?.message || String(error)
    })
    let payload = await fetchPlatformJson(fallbackPath).catch(async (fallbackError) => {
      if (!isPlatformResourceLimitError(fallbackError) || fallbackLimit <= 1) throw fallbackError
      return fetchPlatformJson(buildSeoMonitorActionsPath(workspace, 1, { includeGscProperty: false }))
    })
    rememberSeoActionsResourceLimitFallback(workspace, error)
    return {
      ...payload,
      resourceLimitFallback: {
        route: 'repo_only',
        originalLimit: limit,
        fallbackLimit,
        originalError: error?.message || String(error)
      }
    }
  }
}

function isSeoBatchNotFoundError(error) {
  return String(error?.message || error || '').toLowerCase().includes('seo_batch_not_found')
}

function emptySeoActionsForMissingBatch(workspace, error) {
  logThrottled(`seo_batch_not_found_empty_actions:${workspace?.id || workspace?.repoFullName || workspace?.label || 'default'}`, 30 * 60 * 1000, 'seo_batch_not_found_empty_actions', {
    workspace: workspace?.label || workspace?.id || workspace?.repoFullName,
    error: error?.message || String(error)
  })
  return {
    actions: [],
    missingBatch: true,
    error: 'seo_batch_not_found'
  }
}

function buildSeoMonitorActionsPath(workspace, limit, options = {}) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (workspace) {
    if (options.includeGscProperty !== false) params.set('gscProperty', workspace.gscProperty || '')
    params.set('repoFullName', workspace.repoFullName || '')
    params.set('branch', workspace.branch || '')
  }
  return `/api/platform/seo-monitor/actions?${params.toString()}`
}

function shouldPreferRepoOnlySeoActionsRoute(workspace) {
  return Boolean(workspace?.repoFullName && String(workspace?.gscProperty || '').startsWith('sc-domain:'))
}

function isPlatformResourceLimitError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('platform_503') && (message.includes('error 1102') || message.includes('resource limit'))
}

function isPlatformResourceLimitProbe(check) {
  return Boolean(check?.resourceLimit) || isPlatformResourceLimitError(check?.error || '')
}

function isPlatformResourceLimitPayload(status, payload, preview = '') {
  if (Number(status) !== 503) return false
  const message = [
    payload?.type,
    payload?.title,
    payload?.detail,
    payload?.error,
    preview
  ].filter(Boolean).join(' ').toLowerCase()
  return message.includes('error 1102') || message.includes('resource limit')
}

function seoActionsResourceLimitFallbackKey(workspace) {
  if (!workspace) return ''
  return workspace?.id || `${workspace?.gscProperty || ''}:${workspace?.repoFullName || ''}:${workspace?.branch || 'main'}`
}

function activeSeoActionsResourceLimitFallback(workspace) {
  const key = seoActionsResourceLimitFallbackKey(workspace)
  const fallback = key ? state.seoActionsResourceLimitFallbacks?.[key] : null
  return fallback?.until && Date.parse(fallback.until) > Date.now() ? fallback : null
}

function rememberSeoActionsResourceLimitFallback(workspace, error, ttlMs = 15 * 60 * 1000) {
  const key = seoActionsResourceLimitFallbackKey(workspace)
  if (!key) return
  state.seoActionsResourceLimitFallbacks = state.seoActionsResourceLimitFallbacks || {}
  state.seoActionsResourceLimitFallbacks[key] = {
    route: 'repo_only',
    until: new Date(Date.now() + ttlMs).toISOString(),
    error: error?.message || String(error),
    setAt: new Date().toISOString()
  }
  saveState()
}

function clearSeoActionsResourceLimitFallback(workspace) {
  const key = seoActionsResourceLimitFallbackKey(workspace)
  if (!key || !state.seoActionsResourceLimitFallbacks?.[key]) return
  delete state.seoActionsResourceLimitFallbacks[key]
  saveState()
}

async function enrichActionWithKeywordMetrics(action) {
  if (!shouldUseKeywordPlannerMetrics(action)) return action
  if (!action?.keyword) return action
  const keyword = String(action.keyword).trim()
  if (!keyword) return action
  try {
    const payload = await fetchPlatformJson('/api/platform/ad-automation/keyword-metrics', {
      method: 'POST',
      body: JSON.stringify({ keywords: [keyword] })
    })
    const metrics = Array.isArray(payload.metrics) ? payload.metrics : []
    const metric = metrics.find((item) => normalizeKeywordText(item?.text) === normalizeKeywordText(keyword)) || metrics[0] || null
    return {
      ...action,
      keywordMetrics: metric,
      keywordMetricsStatus: payload.status || (metric ? 'ready' : 'missing')
    }
  } catch (error) {
    return {
      ...action,
      keywordMetricsStatus: 'failed',
      keywordMetricsError: error?.message || String(error)
    }
  }
}

function shouldUseKeywordPlannerMetrics(action) {
  const keyword = String(action?.keyword || '').trim().toLowerCase()
  if (!keyword) return false
  const text = [
    action?.title,
    action?.type,
    action?.why,
    action?.recommendedAction
  ].map((value) => String(value || '').toLowerCase()).join(' ')
  if (keyword.includes('internlänk') || keyword.includes('intern länk') || keyword.includes('internal link')) return false
  if (text.includes('internlänk') || text.includes('intern länk') || text.includes('internal link')) return false
  if (text.includes('on-page') && text.includes('länk')) return false
  return true
}


function githubCommitUrl(repoFullName, commit) {
  const repo = String(repoFullName || '').trim()
  const sha = String(commit || '').trim()
  if (!repo || !sha || !repo.includes('/')) return ''
  return `https://github.com/${repo}/commit/${sha}`
}

function formatCodeActionHistory(workspace) {
  const repo = String(workspace?.repoFullName || '').trim()
  const repoName = repo.split('/').pop().toLowerCase()
  const label = workspace?.label || workspace?.id || 'workspace'
  const entries = Object.entries(state.codeActionResults || {})
    .filter(([, result]) => result && typeof result === 'object')
    .filter(([id, result]) => {
      const haystack = `${id} ${result?.result?.repoDir || ''} ${result?.result?.repoFullName || ''}`.toLowerCase()
      return !repoName || haystack.includes(repoName) || haystack.includes(String(label).toLowerCase())
    })
    .sort((a, b) => Date.parse(b[1].completedAt || b[1].failedAt || 0) - Date.parse(a[1].completedAt || a[1].failedAt || 0))
    .slice(0, 6)
  if (!entries.length) return `Kodhistorik för ${label}: inga kodactions sparade ännu.`
  return [
    `Kodhistorik för ${label}`,
    ...entries.map(([id, result]) => {
      if (result.status === 'completed') {
        const commit = result.result?.commit || ''
        const url = githubCommitUrl(repo, commit)
        return `OK ${commit || id}: ${url || 'GitHub-länk saknas'}\nAction: ${id}`
      }
      return `FAIL ${id}\nFel: ${String(result.error || 'okänt fel').slice(0, 220)}`
    })
  ].join('\n\n').slice(0, 1900)
}

function formatAgentBrainStatus(workspace) {
  const snapshot = agentRuntimeSnapshot({
    workspace,
    state,
    config: {
      codeAutomationEnabled,
      codexChatEnabled,
      smartOutboundGuardEnabled,
      automationEnabled,
      workspaceChannelCount: Object.keys(workspaceChannels).length
    }
  })
  const specs = snapshot.structure.specFiles.map((item) => `${item.ok ? 'OK' : 'FIX'} ${item.file} (${item.bytes} bytes)`).join('\n')
  const workspaceLine = snapshot.workspace
    ? `${snapshot.workspace.label || snapshot.workspace.id} · ${snapshot.workspace.repoFullName || 'repo saknas'} · mål: ${snapshot.workspace.goal}`
    : 'Ingen workspace kopplad till den här kanalen.'
  return [
    'Agentstruktur',
    specs,
    '',
    `Workspace: ${workspaceLine}`,
    `Codex-chat: ${snapshot.config.codexChatEnabled ? 'på' : 'av'}`,
    `Kodautomation: ${snapshot.config.codeAutomationEnabled ? 'på' : 'av'}`,
    `Smart outbound guard: ${snapshot.config.smartOutboundGuardEnabled ? 'på' : 'av'}`,
    `Workspace-kanaler: ${snapshot.config.workspaceChannelCount}`,
    `Minne: ${snapshot.memory.savedGuidanceCount} guidance, ${snapshot.memory.outboundLessons} guard-lessons, ${snapshot.memory.outboundIncidents} incidents.`
  ].join('\n')
}

function formatAgentHealthReport() {
  const results = Object.entries(state.codeActionResults || {})
  const failed = results.filter(([, result]) => ['failed', 'infra_failed', 'build_failed', 'no_changes'].includes(String(result?.status || '')))
  const completed = results.filter(([, result]) => result?.status === 'completed')
  const unresolved = Object.values(state.platformIncidents || {}).filter((item) => !['resolved', 'archived'].includes(String(item?.status || '')))
  const active = Object.values(state.activeActionByWorkspace || {})
  const queue = Object.values(state.approvedCodeActionQueue || {})
  const latestFailed = failed.slice(-5).map(([id, result]) => {
    const failure = result.failure?.category ? ` · ${result.failure.category}` : ''
    return `- ${String(result.status || 'failed')}${failure}: ${shortActionId(id)}`
  })
  const latestCompleted = completed.slice(-5).map(([id, result]) => `- ${result.result?.commit || 'commit?'}: ${shortActionId(id)}`)
  const lessons = (state.agentLessons || []).slice(0, 5).map((item) => `- ${item.text}`)
  return [
    'SEO Agent health',
    `Service-state: running=${state.codeActionRunning?.actionId ? shortActionId(state.codeActionRunning.actionId) : 'nej'}, approvedQueue=${queue.length}, activeCards=${active.length}`,
    `Code actions: completed=${completed.length}, failed/open-failed=${failed.length}`,
    `Platform incidents: unresolved=${unresolved.length}`,
    `Workspaces med active card: ${active.map((item) => shortActionId(item.actionId)).join(', ') || 'inga'}`,
    latestCompleted.length ? `\nSenaste commits:\n${latestCompleted.join('\n')}` : '',
    latestFailed.length ? `\nSenaste fel:\n${latestFailed.join('\n')}` : '',
    lessons.length ? `\nSenaste lärdomar:\n${lessons.join('\n')}` : '',
    '\nTolkning: om activeCards är högt väntar agenten på beslut; om unresolved incidents är högt är Platform API/GSC-data svag; om failed växer ska runner/repo/build fixas innan fler kort approve:as.'
  ].filter(Boolean).join('\n').slice(0, 1900)
}

function shortActionId(id) {
  const text = String(id || '')
  if (text.length <= 80) return text
  return `${text.slice(0, 42)}...${text.slice(-28)}`
}

function formatStatusMessage(workspace, payload) {
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const pending = actions.filter((item) => item.status === 'pending').length
  const approved = actions.filter((item) => item.status === 'approved').length
  const top = actions.find((item) => item.status === 'pending') || actions[0]
  return [
    `SEO Agent status${workspace ? ` för ${workspace.label || workspace.id}` : ''}`,
    payload.error ? `Fel: ${payload.error}` : `Actions: ${actions.length} hämtade, ${pending} pending, ${approved} approved.`,
    top ? `Nästa: ${top.title} (${top.priority || 'medium'})` : 'Inga actions just nu.',
    workspace ? `GSC: ${workspace.gscProperty || 'saknas'} · Repo: ${workspace.repoFullName || 'saknas'} · Branch: ${workspace.branch || 'main'}` : '',
  ].filter(Boolean).join('\n')
}

function ensureAutonomousAgentState() {
  state.workspaceProfiles = state.workspaceProfiles || {}
  state.actionLedger = state.actionLedger || {}
  state.agentLessons = state.agentLessons || []
  state.guardedActions = state.guardedActions || {}
  migrateExistingStateToActionLedger()
}

function cleanupStaleRuntimeState() {
  const now = Date.now()
  let changed = false
  if (state.codeActionRunning?.startedAt && Date.parse(state.codeActionRunning.startedAt) < processStartedAtMs - 10 * 1000) {
    const actionId = state.codeActionRunning.actionId || 'unknown'
    rememberAgentLesson(`Cleared interrupted codeActionRunning lock after worker restart for ${actionId}`)
    log('interrupted_code_action_lock_cleared_after_restart', { actionId, startedAt: state.codeActionRunning.startedAt })
    state.codeActionRunning = null
    changed = true
  } else if (state.codeActionRunning?.startedAt && now - Date.parse(state.codeActionRunning.startedAt) > staleRunningMs) {
    const actionId = state.codeActionRunning.actionId || 'unknown'
    rememberAgentLesson(`Cleared stale codeActionRunning lock for ${actionId}`)
    log('stale_code_action_lock_cleared', { actionId, startedAt: state.codeActionRunning.startedAt })
    state.codeActionRunning = null
    changed = true
  }
  if (state.selfRepairRunning?.startedAt && now - Date.parse(state.selfRepairRunning.startedAt) > staleRunningMs) {
    const repairId = state.selfRepairRunning.id || 'unknown'
    rememberAgentLesson(`Cleared stale self-repair lock for ${repairId}`)
    log('stale_self_repair_lock_cleared', { repairId, startedAt: state.selfRepairRunning.startedAt })
    state.selfRepairRunning = null
    changed = true
  }
  for (const [actionId, item] of Object.entries(state.approvedCodeActionQueue || {})) {
    if (state.codeActionResults?.[actionId]) {
      delete state.approvedCodeActionQueue[actionId]
      changed = true
      continue
    }
    const queuedAt = Date.parse(item?.queuedAt || '')
    if (!queuedAt || now - queuedAt <= staleQueuedApprovedMs) continue
    recordActionLedger(item, workspaceForChannel(item?.channelId || null), item?.channelId || null, 'deprioritized', {
      reason: 'stale_approved_queue_item',
      recheckAfter: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    })
    delete state.approvedCodeActionQueue[actionId]
    rememberAgentLesson(`Removed stale approved queue item ${actionId}`)
    log('stale_approved_queue_item_removed', { actionId, queuedAt: item?.queuedAt || null })
    changed = true
  }
  for (const [activeKey, active] of Object.entries(state.activeActionByWorkspace || {})) {
    const actionId = active?.actionId
    if (!actionId) continue
    if (state.approvedCodeActionQueue?.[actionId] || state.codeActionResults?.[actionId]) {
      delete state.activeActionByWorkspace[activeKey]
      rememberAgentLesson(`Cleared active card lock for queued/resolved action ${actionId}`)
      log('active_action_lock_cleared_for_queued_or_resolved_action', { actionId, activeKey })
      changed = true
      continue
    }
    const firstPostedAt = Date.parse(active?.firstPostedAt || active?.postedAt || active?.repostedAt || active?.lastReminderAt || '')
    if (firstPostedAt && now - firstPostedAt > staleActiveActionMs) {
      recordActionLedger({ id: actionId }, workspaceForChannel(active?.channelId || null), active?.channelId || null, 'deprioritized', {
        reason: 'stale_active_action_lock',
        recheckAfter: new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      })
      delete state.activeActionByWorkspace[activeKey]
      rememberAgentLesson(`Cleared stale active card lock for ${actionId}`)
      log('stale_active_action_lock_cleared', { actionId, activeKey, firstPostedAt: active?.firstPostedAt || active?.postedAt || null })
      changed = true
    }
  }
  for (const [key, incident] of Object.entries(state.platformIncidents || {})) {
    const startedAt = Date.parse(incident?.startedAt || incident?.unresolvedAt || '')
    if (!startedAt || now - startedAt <= 7 * 24 * 60 * 60 * 1000) continue
    state.platformIncidents[key] = { ...incident, status: incident.status === 'resolved' ? 'resolved' : 'archived', archivedAt: new Date().toISOString() }
    changed = true
  }
  for (const [actionId, result] of Object.entries(state.codeActionResults || {})) {
    if (result?.status !== 'failed') continue
    const failedAt = Date.parse(result.failedAt || '')
    if (!failedAt || now - failedAt <= 7 * 24 * 60 * 60 * 1000) continue
    state.codeActionResults[actionId] = { ...result, status: 'archived_failed', archivedAt: new Date().toISOString() }
    changed = true
  }
  if (changed) saveState()
}

function migrateExistingStateToActionLedger() {
  if (state.actionLedgerMigratedAt) return
  const now = new Date().toISOString()
  for (const [actionId, posted] of Object.entries(state.postedActionIds || {})) {
    const action = {
      id: actionId,
      title: posted?.title || actionId,
      targetUrl: posted?.targetUrl || null,
      keyword: posted?.keyword || null
    }
    const workspace = { id: posted?.workspaceId || posted?.workspaceSlug || posted?.projectSlug || null, label: posted?.workspaceId || null }
    const key = actionLearningKey(action, workspace, posted?.channelId || null)
    state.actionLedger[key] = {
      ...(state.actionLedger[key] || {}),
      key,
      actionId,
      title: action.title,
      workspaceKey: workspaceProfileKey(workspace, posted?.channelId || null),
      targetUrl: action.targetUrl,
      keyword: action.keyword,
      status: state.actionLedger[key]?.status || 'proposed',
      firstSeenAt: posted?.postedAt || posted?.repostedAt || now,
      lastEventAt: posted?.repostedAt || posted?.postedAt || now,
      recheckAfter: state.actionLedger[key]?.recheckAfter || defaultLedgerRecheck('proposed', now),
      events: [
        { event: 'migrated_posted', at: posted?.postedAt || posted?.repostedAt || now, messageId: posted?.messageId || null },
        ...(state.actionLedger[key]?.events || [])
      ].slice(0, 20)
    }
  }
  for (const [actionId, result] of Object.entries(state.codeActionResults || {})) {
    const posted = state.postedActionIds?.[actionId] || {}
    const action = { id: actionId, title: posted.title || actionId, targetUrl: posted.targetUrl || null, keyword: posted.keyword || null }
    const workspace = { id: posted.workspaceId || result?.result?.repoFullName || result?.result?.repoDir || null, label: posted.workspaceId || result?.result?.repoFullName || null }
    const key = actionLearningKey(action, workspace, posted.channelId || null)
    const status = result?.status === 'completed' ? 'completed' : result?.status === 'failed' ? 'failed' : String(result?.status || 'seen')
    state.actionLedger[key] = {
      ...(state.actionLedger[key] || {}),
      key,
      actionId,
      title: action.title,
      workspaceKey: workspaceProfileKey(workspace, posted.channelId || null),
      targetUrl: action.targetUrl,
      keyword: action.keyword,
      status,
      commit: result?.result?.commit || state.actionLedger[key]?.commit || null,
      firstSeenAt: state.actionLedger[key]?.firstSeenAt || posted.postedAt || result?.completedAt || result?.failedAt || now,
      lastEventAt: result?.completedAt || result?.failedAt || now,
      recheckAfter: state.actionLedger[key]?.recheckAfter || defaultLedgerRecheck(status, result?.completedAt || result?.failedAt || now),
      events: [
        { event: `migrated_${status}`, at: result?.completedAt || result?.failedAt || now, commit: result?.result?.commit || null, error: result?.error || null },
        ...(state.actionLedger[key]?.events || [])
      ].slice(0, 20)
    }
  }
  state.actionLedgerMigratedAt = now
}

function workspaceProfileKey(workspace, targetChannelId = null) {
  return String(workspace?.id || workspace?.gscProperty || workspace?.repoFullName || targetChannelId || 'default')
}

function ensureWorkspaceProfile(workspace, targetChannelId = null) {
  ensureAutonomousAgentState()
  const key = workspaceProfileKey(workspace, targetChannelId)
  const existing = state.workspaceProfiles[key] || {}
  const defaults = defaultWorkspaceProfile(workspace)
  const profile = {
    ...defaults,
    ...existing,
    goals: [...new Set([...(existing.goals || []), ...(defaults.goals || [])])].slice(0, 20),
    prefer: [...new Set([...(existing.prefer || []), ...(defaults.prefer || [])])].slice(0, 30),
    avoid: [...new Set([...(existing.avoid || []), ...(defaults.avoid || [])])].slice(0, 30),
    updatedAt: existing.updatedAt || new Date().toISOString()
  }
  state.workspaceProfiles[key] = profile
  return profile
}

function defaultWorkspaceProfile(workspace) {
  const label = String(workspace?.label || workspace?.id || '').toLowerCase()
  if (label.includes('sebcastwall')) {
    return {
      label: workspace?.label || 'sebcastwall.se',
      goals: ['rank higher for AI consulting, AI agents, automation, app/web and AI education leads'],
      prefer: ['AI konsult', 'AI-agenter', 'AI-automation', 'kodning', 'app/web', 'interna verktyg', 'AI-utbildningar', 'workshops'],
      avoid: ['Fortnox-only', 'Visma-only', 'Business Central-only', 'Abicart/Klarna', 'generic integration-only', 'invoice/bookkeeping-only'],
      autonomy: 'approve_before_code'
    }
  }
  if (label.includes('natverkskollen')) {
    return {
      label: workspace?.label || 'natverkskollen.se',
      goals: ['rank higher for startup events, networking and evergreen event landing pages'],
      prefer: ['startup events', 'nätverkande', 'entreprenörer', 'city pages', 'event category pages'],
      avoid: ['agency consulting', 'software integration', 'unrelated AI consultancy'],
      autonomy: 'approve_before_code'
    }
  }
  if (label.includes('parkeringspolaren')) {
    return {
      label: workspace?.label || 'parkeringspolaren.se',
      goals: ['rank higher for parking intent and conversion landing pages'],
      prefer: ['parkering', 'flygplatsparkering', 'långtidsparkering', 'lokal intent', 'indexering', 'conversion'],
      avoid: ['unrelated software/AI consultancy'],
      autonomy: 'approve_before_code'
    }
  }
  return {
    label: workspace?.label || workspace?.id || 'workspace',
    goals: ['rank higher on relevant valuable search demand'],
    prefer: [],
    avoid: [],
    autonomy: 'approve_before_code'
  }
}

function shouldPostActionCard(action, workspace, targetChannelId) {
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const text = actionText(action)
  const cluster = actionLearningKey(action, workspace, targetChannelId)
  const ledger = state.actionLedger?.[cluster]
  if (ledger?.status === 'completed' && !isLedgerRecheckDue(ledger)) return { ok: false, reason: 'already_completed_waiting_recheck' }
  if (ledger?.status === 'ignored' && !isLedgerRecheckDue(ledger)) return { ok: false, reason: 'previously_ignored_waiting_recheck' }
  if (Number(ledger?.guardedCount || 0) >= 2 && !isLedgerRecheckDue(ledger)) return { ok: false, reason: 'repeatedly_guarded' }
  if (profile.avoid?.some((term) => text.includes(normalizeForMatch(term))) && !profile.prefer?.some((term) => text.includes(normalizeForMatch(term)))) {
    return { ok: false, reason: 'workspace_avoid_terms_without_preferred_context' }
  }
  if (workspaceProfileKey(workspace, targetChannelId).includes('sebcastwall') || String(profile.label || '').toLowerCase().includes('sebcastwall')) {
    if (/\b(abicart|klarna|fortnox|fortknox|visma|business-central|business central|mailchimp|monday|zendesk|account-status|help-outline)\b/.test(text)) {
      return { ok: false, reason: 'sebcastwall_noise_keyword' }
    }
  }
  if (action.keyword) {
    const words = String(action.keyword).trim().split(/\s+/).filter(Boolean).length
    if (String(action.keyword).length > 90 || words > 8) return { ok: false, reason: 'keyword_too_long_for_action_card' }
  }
  return { ok: true, reason: 'passed' }
}

function rememberGuardedAction(action, workspace, targetChannelId, reason) {
  recordActionLedger(action, workspace, targetChannelId, 'guarded', { reason })
  const key = actionLearningKey(action, workspace, targetChannelId)
  state.guardedActions[key] = { actionId: action.id || null, title: action.title || '', reason, at: new Date().toISOString() }
  rememberAgentLesson(`Guarded ${key}: ${reason}`)
}

function recordDecisionInLedger(actionId, decision, targetChannelId, meta = {}) {
  const action = fallbackActionFromState(actionId, targetChannelId) || { id: actionId, title: actionId }
  const workspace = workspaceForChannel(targetChannelId)
  const event = decision === 'approved' ? 'approved' : decision === 'skipped' ? 'ignored' : decision === 'deprioritized' ? 'deprioritized' : decision === 'stopped' ? 'stopped' : String(decision || 'decision')
  recordActionLedger(action, workspace, targetChannelId, event, meta)
}

function recordActionLedger(action, workspace, targetChannelId, event, meta = {}) {
  ensureAutonomousAgentState()
  const key = actionLearningKey(action, workspace, targetChannelId)
  const now = new Date().toISOString()
  const existing = state.actionLedger[key] || {
    key,
    actionId: action.id || null,
    title: action.title || '',
    workspaceKey: workspaceProfileKey(workspace, targetChannelId),
    targetUrl: action.targetUrl || action.url || null,
    keyword: action.keyword || null,
    firstSeenAt: now,
    events: []
  }
  const status = ledgerStatusForEvent(event, existing.status)
  state.actionLedger[key] = {
    ...existing,
    actionId: action.id || existing.actionId || null,
    title: action.title || existing.title || '',
    targetUrl: action.targetUrl || action.url || existing.targetUrl || null,
    keyword: action.keyword || existing.keyword || null,
    status,
    guardedCount: event === 'guarded' ? Number(existing.guardedCount || 0) + 1 : Number(existing.guardedCount || 0),
    lastEventAt: now,
    recheckAfter: meta.recheckAfter || existing.recheckAfter || defaultLedgerRecheck(status, now),
    commit: meta.commit || existing.commit || null,
    events: [
      { event, at: now, ...meta },
      ...(existing.events || [])
    ].slice(0, 20)
  }
  if (event === 'completed') rememberAgentLesson(`Completed ${key}${meta.commit ? ` in ${meta.commit}` : ''}`)
  if (event === 'failed') rememberAgentLesson(`Failed ${key}: ${String(meta.error || 'unknown').slice(0, 160)}`)
}

function ledgerStatusForEvent(event, fallback = 'seen') {
  if (event === 'posted') return 'proposed'
  if (event === 'approved') return 'approved'
  if (event === 'coding_started') return 'coding'
  if (event === 'completed') return 'completed'
  if (event === 'failed') return 'failed'
  if (event === 'ignored' || event === 'skipped') return 'ignored'
  if (event === 'deprioritized') return 'deprioritized'
  if (event === 'stopped') return 'stopped'
  if (event === 'guarded') return fallback || 'guarded'
  return event || fallback || 'seen'
}

function defaultLedgerRecheck(status, nowIso) {
  const date = new Date(nowIso)
  if (status === 'completed') date.setDate(date.getDate() + 14)
  else if (status === 'ignored' || status === 'deprioritized' || status === 'guarded') date.setDate(date.getDate() + 45)
  else date.setDate(date.getDate() + 7)
  return date.toISOString().slice(0, 10)
}

function isLedgerRecheckDue(ledger) {
  return Boolean(ledger?.recheckAfter && ledger.recheckAfter <= new Date().toISOString().slice(0, 10))
}

function actionLearningKey(action, workspace, targetChannelId) {
  const workspaceKey = normalizeClusterPart(workspaceProfileKey(workspace, targetChannelId))
  const target = normalizeActionPath(action.targetUrl || action.url || action.path || '')
  const keyword = normalizeKeywordCluster(action.keyword || action.title || '')
  const kind = actionKindForLearning(action)
  if (target && (kind === 'content' || kind === 'internal-links')) return `${workspaceKey}:${target}:${kind}`
  return `${workspaceKey}:${target || 'no-path'}:${keyword || 'no-keyword'}:${kind}`
}

function actionKindForLearning(action) {
  const text = actionText(action)
  if (/indexering|url-inspection|gsc|oauth/.test(text) && !/title|h1|meta|copy|faq|content/.test(text)) return 'indexing'
  if (/internlank|interna-lank|internal-link/.test(text)) return 'internal-links'
  if (/ny-sida|new-page|landningssida/.test(text)) return 'new-page'
  if (/title|meta|h1|h2|intro|faq|copy|content|readiness|serp|keyword|ranking/.test(text)) return 'content'
  return 'general'
}

function actionText(action) {
  return normalizeForMatch([action.title, action.keyword, action.targetUrl, action.why, action.recommendedAction, action.category].filter(Boolean).join(' '))
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9/.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function rememberAgentLesson(text) {
  state.agentLessons = state.agentLessons || []
  const lesson = { text: String(text || '').slice(0, 240), at: new Date().toISOString() }
  state.agentLessons = [lesson, ...state.agentLessons.filter((item) => item.text !== lesson.text)].slice(0, 80)
}

function formatWorkspaceProfileMessage(workspace, targetChannelId) {
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  return [
    `Workspace-mål: ${profile.label}`,
    `Mål: ${(profile.goals || []).join('; ') || 'ranka högre på relevant efterfrågan'}`,
    `Prioritera: ${(profile.prefer || []).join(', ') || 'saknas'}`,
    `Undvik: ${(profile.avoid || []).join(', ') || 'saknas'}`,
    `Autonomi: ${profile.autonomy || 'approve_before_code'}`
  ].join('\n').slice(0, 1900)
}

function formatActionLedgerSummary(workspace, targetChannelId) {
  const key = workspaceProfileKey(workspace, targetChannelId)
  const entries = Object.values(state.actionLedger || {})
    .filter((item) => String(item.workspaceKey || '') === String(key))
    .sort((a, b) => Date.parse(b.lastEventAt || b.firstSeenAt || 0) - Date.parse(a.lastEventAt || a.firstSeenAt || 0))
    .slice(0, 8)
  const lessons = (state.agentLessons || []).slice(0, 5).map((item) => `- ${item.text}`)
  return [
    `Agentminne för ${workspace?.label || key}`,
    entries.length ? entries.map((item) => `${item.status || 'seen'} · ${item.title || item.key}${item.commit ? ` · ${item.commit}` : ''}`).join('\n') : 'Inga ledger-händelser för workspacet ännu.',
    lessons.length ? `\nSenaste lärdomar:\n${lessons.join('\n')}` : ''
  ].filter(Boolean).join('\n').slice(0, 1900)
}

function ledgerActionsForWorkspace(workspace, targetChannelId) {
  const key = workspaceProfileKey(workspace, targetChannelId)
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  return Object.values(state.actionLedger || {})
    .filter((item) => String(item.workspaceKey || '') === String(key))
    .filter((item) => item.actionId && item.title)
    .filter((item) => !['completed', 'ignored', 'stopped'].includes(String(item.status || '')) || isLedgerRecheckDue(item))
    .filter((item) => String(item.status || '') !== 'failed' || isLedgerRecheckDue(item))
    .filter((item) => {
      const text = normalizeForMatch([item.title, item.keyword, item.targetUrl, item.key].filter(Boolean).join(' '))
      if (profile.avoid?.some((term) => text.includes(normalizeForMatch(term))) && !profile.prefer?.some((term) => text.includes(normalizeForMatch(term)))) return false
      return true
    })
    .sort((a, b) => ledgerActionPriority(b, profile) - ledgerActionPriority(a, profile))
    .map((item) => ({
      id: item.actionId,
      title: item.title,
      targetUrl: item.targetUrl || '',
      keyword: item.keyword || '',
      status: item.status || 'memory',
      priority: item.priority || 'medium',
      category: item.kind || 'memory',
      why: `Hämtad från agentens minne/ledger eftersom live action-data är begränsad. Senast status: ${item.status || 'seen'}.`,
      recommendedAction: item.commit
        ? `Tidigare commit finns: ${item.commit}. Reposta bara om ny recheck visar att mer behövs.`
        : 'Reposta kortet med knappar eller approve om åtgärden fortfarande matchar målet.',
      priorityReason: 'ledger fallback när live action-data saknas'
    }))
}

function ledgerActionPriority(item, profile) {
  const text = normalizeForMatch([item.title, item.keyword, item.targetUrl, item.key].filter(Boolean).join(' '))
  let score = 0
  if (String(item.status || '') === 'proposed' || String(item.status || '') === 'approved') score += 30
  if (String(item.status || '') === 'deprioritized') score -= 15
  if (/ai|agent|automatisering|automation|app|webb|utbildning|workshop/.test(text)) score += 20
  if (/indexering|gsc|oauth/.test(text)) score += 8
  if (profile.prefer?.some((term) => text.includes(normalizeForMatch(term)))) score += 25
  const last = Date.parse(item.lastEventAt || item.firstSeenAt || '')
  if (last) score += Math.max(0, 10 - Math.floor((Date.now() - last) / (7 * 24 * 60 * 60 * 1000)))
  return score
}

async function findAction(actionId) {
  const fallback = fallbackActionFromState(actionId)
  if (fallback) return fallback
  const workspaces = await listWorkspaces().catch(() => [])
  for (const workspace of [null, ...workspaces]) {
    const payload = workspace
      ? await fetchActionsForChat(workspace).catch(() => ({ actions: [] }))
      : await fetchPlatformJson('/api/platform/seo-monitor/actions?limit=20').catch(() => ({ actions: [] }))
    const actions = Array.isArray(payload.actions) ? payload.actions : []
    const match = actions.find((item) => String(item.id || '') === String(actionId))
    if (match) return match
  }
  return null
}

function fallbackActionFromState(actionId, targetChannelId = null, workspace = null) {
  const id = String(actionId || '')
  if (!id) return null
  const posted = state.postedActionIds?.[id] || null
  const active = Object.values(state.activeActionByWorkspace || {}).find((record) => (
    String(record?.actionId || '') === id &&
    (!targetChannelId || String(record?.channelId || '') === String(targetChannelId))
  )) || null
  if (!posted && !active) return null
  const inferredTargetUrl = inferFallbackActionTargetUrl(id, workspace, active, posted)
  const isIndexing = /kontrollera-indexering|url-inspection|beg-r-indexering|begar-indexering/i.test(id) || /kontrollera indexering|url inspection|begär indexering|begar indexering/i.test(posted?.title || '')
  return {
    id,
    title: posted?.title || (isIndexing ? 'Kontrollera indexering' : 'SEO action'),
    targetUrl: inferredTargetUrl,
    url: inferredTargetUrl,
    keyword: null,
    priority: 'medium',
    category: isIndexing ? 'indexing' : 'manual',
    why: 'Kortet finns i Discord-agentens state men finns inte i senaste topp-listan från SEO Monitor.',
    recommendedAction: isIndexing
      ? 'Öppna GSC URL Inspection för den sparade workspace-URL:en och markera kortet när GSC visar att URL:en är indexerad.'
      : 'Spara beslutet på action-id:t och gå vidare.',
    status: 'pending',
    workspaceId: workspace?.id || active?.workspaceId || posted?.workspaceId || null,
    workspaceSlug: workspace?.label || active?.workspaceId || posted?.workspaceId || null,
    projectSlug: workspace?.label || active?.workspaceId || posted?.workspaceId || null,
    source: 'discord_state'
  }
}

function inferFallbackActionTargetUrl(actionId, workspace = null, active = null, posted = null) {
  const candidates = [
    workspace?.gscProperty,
    workspace?.id,
    active?.workspaceId,
    posted?.workspaceId
  ].filter(Boolean).map(String)
  for (const value of candidates) {
    const firstPart = value.split('__')[0]
    if (/^https?:\/\//i.test(firstPart)) return ensureTrailingSlash(firstPart)
    const domain = firstPart.replace(/^sc-domain:/, '').trim()
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return `https://${domain}/`
  }
  const id = String(actionId || '')
  const domainMatch = id.match(/(?:^|_)([a-z0-9-]+)-se(?:_|$)/i)
  if (domainMatch?.[1]) return `https://${domainMatch[1].replace(/-/g, '')}.se/`
  return null
}

function ensureTrailingSlash(value) {
  const text = String(value || '').trim()
  if (!text) return text
  try {
    const parsed = new URL(text)
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/'
      return parsed.toString()
    }
  } catch {}
  return text.endsWith('/') ? text : `${text}/`
}

function parseCommand(content) {
  const match = content.trim().match(/^(approve|approved|skip|skipped|deprioritize|deprioritized|prioritera bort|needs_context|context|stop|stopped|why)\s+([a-zA-Z0-9_.:-]+)(?:\s+(.+))?$/i)
  if (!match) return null
  const verb = match[1].toLowerCase()
  const decision = verb === 'approve' || verb === 'approved'
    ? 'approved'
    : verb === 'skip' || verb === 'skipped'
      ? 'skipped'
      : verb === 'deprioritize' || verb === 'deprioritized' || verb === 'prioritera bort'
        ? 'deprioritized'
        : verb === 'stop' || verb === 'stopped'
          ? 'stopped'
          : verb === 'why'
            ? 'why'
            : 'needs_context'
  return {
    decision,
    actionId: match[2],
    reason: match[3] || ''
  }
}

function formatActionMessage(action, workspacePolicy, workspace) {
  if (isGscAuthAction(action)) return formatGscAuthMessage(action, workspacePolicy, workspace)
  const showKeywordAsSearchTerm = shouldUseKeywordPlannerMetrics(action)
  const lines = [
    `SEO action: ${action.title || 'Untitled'}`,
    `ID: \`${action.id}\``,
    `Workspace: ${workspace?.label || action.workspaceSlug || action.projectSlug || 'unknown'}`,
    `Priority: ${action.priority || 'medium'}`,
    action.targetUrl ? `URL: ${action.targetUrl}` : '',
    action.keyword ? `${showKeywordAsSearchTerm ? 'Keyword' : 'Focus'}: ${action.keyword}` : '',
    showKeywordAsSearchTerm ? formatKeywordMetricsLine(action) : '',
    '',
    `Why: ${action.why || 'Ingen förklaring sparad.'}`,
    `Recommended: ${action.recommendedAction || 'Review action.'}`,
    workspacePolicy ? `Policy: ${workspacePolicy}` : '',
    '',
    isCodeAction(action)
      ? `Svara: \`approve ${action.id}\`, \`skip ${action.id}\`, \`deprioritize ${action.id}\` eller \`why ${action.id}\`.`
      : `Det här är en GSC/browser-check, inte en kodaction. Tryck Open in GSC för att öppna Search Console-fönstret, eller svara: \`skip ${action.id}\` när den är hanterad, \`deprioritize ${action.id}\` om den kan vänta, eller \`why ${action.id}\`.`
  ]
  return lines.filter(Boolean).join('\n').slice(0, 1900)
}

function formatKeywordMetricsLine(action) {
  if (!action?.keyword) return ''
  const metrics = action.keywordMetrics && typeof action.keywordMetrics === 'object' ? action.keywordMetrics : null
  if (metrics) {
    return [
      'Keyword Planner:',
      metricValue(metrics.avgMonthlySearches, 'volym okänd', (value) => `${value} sök/mån`),
      metrics.competition ? `competition ${String(metrics.competition).toLowerCase()}` : '',
      metricValue(metrics.lowTopOfPageBid, '', (value) => `low bid ${value} SEK`),
      metricValue(metrics.highTopOfPageBid, '', (value) => `high bid ${value} SEK`),
      metricValue(metrics.averageCpc, '', (value) => `avg CPC ${value} SEK`)
    ].filter(Boolean).join(' · ')
  }
  if (action.keywordMetricsStatus === 'failed') return `Keyword Planner: kunde inte hämta metrics (${action.keywordMetricsError || 'okänt fel'}).`
  if (action.keywordMetricsStatus && action.keywordMetricsStatus !== 'ready') return `Keyword Planner: ${action.keywordMetricsStatus}.`
  return 'Keyword Planner: metrics saknas.'
}

function metricValue(value, fallback, format) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? format(number) : fallback
}

function normalizeKeywordText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function actionComponents(action) {
  const buttons = []
  const add = (decision, label, style) => {
    buttons.push({
      type: 2,
      custom_id: `seo-decision:${decision}`,
      label,
      style,
    })
  }
  if (isCodeAction(action)) {
    add('approved', 'Approve', 3)
    add('skipped', 'Skip', 2)
  } else if (isIndexingCheckAction(action)) {
    buttons.push({ type: 2, custom_id: 'seo-gsc-ui:inspect', label: 'Open in GSC', style: 1 })
    add('skipped', 'Mark handled', 2)
  } else {
    add('skipped', 'Mark handled', 2)
  }
  add('deprioritized', 'Deprioritize', 2)
  add('stopped', 'Stop', 4)
  return buttons.length ? [{ type: 1, components: buttons.slice(0, 5) }] : []
}

function formatGscAuthMessage(action, workspacePolicy, workspace) {
  const lines = [
    `GSC-koppling behöver fixas`,
    `ID: \`${action.id}\``,
    `Workspace: ${workspace?.label || action.workspaceSlug || action.projectSlug || 'unknown'}`,
    workspace?.gscProperty ? `GSC property: ${workspace.gscProperty}` : '',
    action.targetUrl ? `Exempel-URL: ${action.targetUrl}` : '',
    '',
    `Vad betyder det: SEO-agenten kan inte lita på URL Inspection just nu eftersom Google Search Console OAuth/token ger fel.`,
    `Var kopplas det: Dashboard2 -> SEO Monitor -> Integrations -> Google Search Console. Välj rätt workspace/property och kör reconnect OAuth.`,
    `Varför viktigt: utan fungerande GSC-koppling blir indexeringsstatus och URL Inspection brusiga, och agenten kan föreslå fel åtgärder.`,
    workspacePolicy ? `Policy: ${workspacePolicy}` : '',
    '',
    `Svara: \`skip ${action.id}\` om du redan vet att GSC ska ignoreras, \`deprioritize ${action.id}\` om det kan vänta, eller \`why ${action.id}\` för mer detaljer.`
  ]
  return lines.filter(Boolean).join('\n').slice(0, 1900)
}

function isGscAuthAction(action) {
  const text = `${action.title || ''} ${action.why || ''} ${action.recommendedAction || ''}`.toLowerCase()
  return text.includes('oauth-tokenutbyte') || text.includes('url inspection-fel') || text.includes('gsc url inspection')
}

function isIndexingCheckAction(action) {
  const text = `${action.title || ''} ${action.why || ''} ${action.recommendedAction || ''} ${action.category || ''}`.toLowerCase()
  return text.includes('kontrollera indexering') || text.includes('url inspection') || text.includes('begär indexering') || text.includes('begar indexering') || text.includes('webbadressen är okänd') || text.includes('webbadressen ar okand')
}

function isCodeAction(action) {
  return !isGscAuthAction(action) && !isIndexingCheckAction(action)
}

function systemClusterKey(action) {
  if (isGscAuthAction(action)) return `gsc-auth:${action.workspaceSlug || action.projectSlug || 'unknown'}`
  const workspace = normalizeClusterPart(action.workspaceId || action.workspaceSlug || action.projectSlug || action.gscProperty || action.repoFullName || 'unknown')
  const targetPath = normalizeActionPath(action.targetUrl || action.url || action.path || '')
  const keyword = normalizeKeywordCluster(action.keyword || '')
  if (!targetPath && !keyword) return null
  return `seo:${workspace}:${targetPath || 'no-path'}:${keyword || 'no-keyword'}`
}

function normalizeActionPath(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return normalizeClusterPart(parsed.pathname || '/')
  } catch {
    return normalizeClusterPart(raw.replace(/^https?:\/\/[^/]+/i, '').split('?')[0] || raw)
  }
}


function normalizeKeywordCluster(value) {
  const normalized = normalizeClusterPart(value)
  const compact = normalized.replace(/[-/_.]+/g, '')
  if (/aiagent(er)?foretag/.test(compact) || /aiagenterforetag/.test(compact)) return 'ai-agent-foretag'
  if (/aiutbildning|aiutbildningar|aikurs|aikurser/.test(compact)) return 'ai-utbildning'
  return normalized
}

function normalizeClusterPart(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9/.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140)
}

async function fetchPlatformJson(path, init = {}) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
    ...(platformToken ? { authorization: `Bearer ${platformToken}` } : {}),
    ...(init.headers || {})
  }
  const url = `${platformApiUrl}${path}`
  const response = await fetch(url, { ...init, headers })
  const text = await response.text()
  const contentType = response.headers.get('content-type') || ''
  let payload = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch (error) {
      const preview = text.replace(/\s+/g, ' ').slice(0, 180)
      const htmlHint = /^\s*</.test(text) || contentType.includes('text/html') ? 'html_response' : 'invalid_json'
      throw new Error(`platform_${response.status}_${htmlHint}: ${path} returned ${contentType || 'unknown content-type'} · ${preview}`)
    }
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && payload.error ? payload.error : text.slice(0, 200)
    throw new Error(`platform_${response.status}: ${message}`)
  }
  return payload
}

async function sendDiscordMessage(content, targetChannelId = channelId, components = [], options = {}) {
  const checked = await validateOutboundDiscordMessage(String(content ?? ''), targetChannelId, components, options)
  return discordJson(`/channels/${targetChannelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: checked.content, ...(components.length ? { components } : {}) })
  })
}

async function validateOutboundDiscordMessage(content, targetChannelId, components = [], options = {}) {
  const kind = options.kind || inferOutboundMessageKind(content, components)
  const hardIssue = detectOutboundMessageIssue(content, targetChannelId)
  if (hardIssue) return blockOutboundAndRepair({ content, targetChannelId, issue: hardIssue, mode: 'hard_guard' })
  const shapeIssue = validateOutboundShape(content, targetChannelId, components, kind)
  if (!shapeIssue) return { content }
  if (shapeIssue.severity === 'block') return blockOutboundAndRepair({ content, targetChannelId, issue: shapeIssue, mode: `shape_guard:${kind}` })
  if (!shouldSmartReviewOutbound(content, components, kind, shapeIssue)) return { content }
  const review = await smartReviewOutboundMessage(content, targetChannelId, components, { kind, shapeIssue }).catch((error) => ({ decision: 'allow', reason: `smart_review_failed:${error?.message || String(error)}` }))
  rememberOutboundReview({ content, targetChannelId, review })
  if (review.decision === 'rewrite' && review.rewrite) {
    const rewritten = String(review.rewrite).trim().slice(0, 1900)
    const rewrittenIssue = detectOutboundMessageIssue(rewritten, targetChannelId)
    if (rewrittenIssue) return blockOutboundAndRepair({ content: rewritten, targetChannelId, issue: { reason: `bad_rewrite:${rewrittenIssue.reason}`, review }, mode: 'smart_guard_rewrite_failed' })
    return { content: rewritten }
  }
  if (review.decision === 'block') {
    return blockOutboundAndRepair({ content, targetChannelId, issue: { reason: review.reason || 'smart_guard_blocked', review }, mode: 'smart_guard' })
  }
  return { content }
}

function shouldSmartReviewOutbound(content, components = [], kind = 'unknown', shapeIssue = null) {
  if (!smartOutboundGuardEnabled || !codexChatEnabled) return false
  const trimmed = String(content || '').trim()
  if (!trimmed || trimmed.startsWith('Jag stoppade ett felaktigt agentsvar')) return false
  if (!shapeIssue) return false
  return shapeIssue.severity === 'review'
}

function inferOutboundMessageKind(content, components = []) {
  const text = String(content || '')
  if (components.length) return 'action_card'
  if (/^Action handled:|^Decision stored\./.test(text)) return 'decision_confirmation'
  if (/^SEO Agent status|Actions:|Nästa:/.test(text)) return 'status_summary'
  if (/Kunde inte|misslyckades|Fel:|Självläkning|stoppade ett felaktigt/.test(text)) return 'error_notice'
  if (/SEO Agent är online|Integration doctor|OAuth|Kodautomation är inte redo/.test(text)) return 'status_summary'
  return 'chat_reply'
}

function validateOutboundShape(content, targetChannelId, components = [], kind = 'unknown') {
  const text = String(content || '').trim()
  if (!text) return { reason: `${kind}:empty`, severity: 'block' }
  if (text.length > 1900) return { reason: `${kind}:too_long`, severity: 'review' }
  if (/```json|^\s*[\[{]/.test(text) && kind !== 'error_notice') return { reason: `${kind}:looks_like_raw_structured_output`, severity: 'block' }
  if (kind === 'action_card') {
    if (!/seo_action_|mail_action_|Action:|ID:/.test(text)) return { reason: 'action_card:missing_action_id', severity: 'review' }
    if (!/approve|skip|deprioritize|stop/i.test(text)) return { reason: 'action_card:missing_decision_options', severity: 'review' }
  }
  if (kind === 'decision_confirmation') {
    if (!/Decision|decision|beslut|handled|stored|approved|skipped|deprioritized|send_approved/.test(text)) return { reason: 'decision_confirmation:missing_decision', severity: 'review' }
  }
  if (kind === 'status_summary') {
    if (!/status|Actions:|Nästa:|OK|FIX|OAuth|online|redo|saknas/i.test(text)) return { reason: 'status_summary:missing_status_signal', severity: 'review' }
  }
  if (kind === 'error_notice') {
    if (!/Fel:|Orsak:|misslyckades|Kunde inte|Självläkning|Fix:/i.test(text)) return { reason: 'error_notice:missing_error_or_fix', severity: 'review' }
  }
  if (kind === 'chat_reply') {
    if (/approve seo_action_/.test(text) && !/varför|nästa|rekommender/i.test(text.toLowerCase())) return { reason: 'chat_reply:command_without_explanation', severity: 'review' }
    if (/pilotläge|pilotlage/i.test(text)) return { reason: 'chat_reply:stale_pilot_language', severity: 'block' }
  }
  return null
}

async function smartReviewOutboundMessage(content, targetChannelId, components = [], reviewContext = {}) {
  const workspace = workspaceForChannel(targetChannelId)
  const context = {
    workspace,
    channelId: targetChannelId,
    hasButtons: components.length > 0,
    expectedKind: reviewContext.kind || 'unknown',
    shapeIssue: reviewContext.shapeIssue || null,
    message: content.slice(0, 2600),
    recentLessons: (state.outboundGuardLessons || []).slice(0, 12),
    recentIncidents: (state.outboundMessageIncidents || []).slice(0, 8).map((item) => ({ at: item.at, error: item.error, workspace: item.workspace }))
  }
  const promptPath = join(stateDir, 'codex-outbound-review.md')
  const prompt = [
    'Du är en smart outbound guard för SEO Agent i Discord.',
    'Bedöm om meddelandet är säkert och begripligt att posta till användaren i rätt workspace-kanal.',
    'Returnera ENDAST JSON: {"decision":"allow|rewrite|block","reason":"kort orsak","rewrite":"om rewrite, ny svensk text"}',
    '',
    'Blockera om:',
    '- rå JSON/tool/Codex-stream visas för användaren',
    '- fel workspace, domän eller repo blandas in',
    '- svaret är förvirrande, säger pilotläge felaktigt, eller ber användaren göra oklart arbete',
    '- svaret borde vara en kortare tydlig instruktion',
    '',
    'Rewrite om innehållet i sak är rätt men behöver bli tydligare eller kortare.',
    'Allow om det är korrekt, tydligt och workspace-säkert.',
    '',
    'AGENT SPEC:',
    readAgentSpecs(),
    '',
    'CONTEXT JSON:',
    JSON.stringify(context, null, 2)
  ].join('\n')
  writeFileSync(promptPath, prompt)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const result = await execCodexTracked({
    agent: 'seo-agent',
    purpose: 'outbound_review',
    workspace: context?.workspace?.label || context?.workspace?.id || null,
    command: `codex exec --json --cd /home/deploy/seo-agent-discord --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`,
    timeout: 3 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024
  })
  const text = extractCodexExecText(result.stdout || '')
  return normalizeOutboundReview(text)
}

function normalizeOutboundReview(text) {
  const raw = String(text || '').trim()
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw
  let parsed = null
  try { parsed = JSON.parse(jsonText) } catch { return { decision: 'allow', reason: 'review_json_parse_failed' } }
  const decision = ['allow', 'rewrite', 'block'].includes(parsed.decision) ? parsed.decision : 'allow'
  return {
    decision,
    reason: String(parsed.reason || '').slice(0, 300),
    rewrite: typeof parsed.rewrite === 'string' ? parsed.rewrite.slice(0, 1900) : ''
  }
}

function rememberOutboundReview({ content, targetChannelId, review }) {
  state.outboundGuardReviews = state.outboundGuardReviews || []
  state.outboundGuardReviews.unshift({ at: new Date().toISOString(), channelId: targetChannelId, decision: review.decision, reason: review.reason, preview: String(content || '').slice(0, 300) })
  state.outboundGuardReviews = state.outboundGuardReviews.slice(0, 50)
  if (review.decision !== 'allow') {
    state.outboundGuardLessons = state.outboundGuardLessons || []
    state.outboundGuardLessons.unshift({ at: new Date().toISOString(), decision: review.decision, reason: review.reason })
    state.outboundGuardLessons = state.outboundGuardLessons.slice(0, 30)
  }
  saveState()
}

async function blockOutboundAndRepair({ content, targetChannelId, issue, mode }) {
  const workspace = workspaceForChannel(targetChannelId)
  const incident = {
    id: `outbound-message:${Date.now()}`,
    workspace: workspace?.label || workspace?.id || null,
    error: issue.reason,
    path: `sendDiscordMessage:${mode}`,
    attempts: [{ contentPreview: content.slice(0, 700), channelId: targetChannelId, issue }],
    doctor: null
  }
  log('outbound_message_blocked', incident)
  let codeRepair = null
  if (codeAutomationEnabled) {
    codeRepair = await runSelfRepairCodex(incident).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  }
  state.outboundMessageIncidents = state.outboundMessageIncidents || []
  state.outboundMessageIncidents.unshift({ ...incident, codeRepair, at: new Date().toISOString() })
  state.outboundMessageIncidents = state.outboundMessageIncidents.slice(0, 25)
  saveState()
  if (codeRepair?.ok && codeRepair.changed) scheduleSelfRestart()
  return {
    content: [
      'Jag stoppade ett felaktigt agentsvar innan det postades.',
      `Orsak: ${issue.reason}`,
      codeRepair?.ok ? `Självfix: ${codeRepair.changed ? 'patch gjord, agenten startar om.' : 'kontrollerad, ingen patch behövdes.'}` : `Självfix: ${codeRepair?.error || 'ej körd'}`,
      'Försök igen om en stund, eller skriv `status`.'
    ].join('\n').slice(0, 1900)
  }
}

function detectOutboundMessageIssue(content, targetChannelId) {
  const trimmed = String(content || '').trim()
  if (!trimmed) return { reason: 'empty_message' }
  if (/^\{"type":"(thread|turn|item)\./.test(trimmed) || trimmed.includes('"type":"thread.started"') || trimmed.includes('"type":"turn.started"')) {
    return { reason: 'raw_codex_json_stream' }
  }
  const workspace = workspaceForChannel(targetChannelId)
  const label = String(workspace?.label || '').toLowerCase()
  const lower = trimmed.toLowerCase()
  const knownSites = ['sebcastwall.se', 'natverkskollen.se', 'parkeringspolaren.se']
  for (const site of knownSites) {
    if (label && site !== label && lower.includes(site)) return { reason: `cross_workspace_reference:${site}_in_${label}` }
  }
  const repo = String(workspace?.repoFullName || '').toLowerCase()
  const knownRepos = ['sajden/sebcastwall', 'sajden/natverkskollen', 'sajden/parkeringspolaren-web']
  for (const knownRepo of knownRepos) {
    if (repo && knownRepo !== repo && lower.includes(knownRepo)) return { reason: `cross_workspace_repo:${knownRepo}_in_${repo}` }
  }
  return null
}

async function sendOncePerDay(key, targetChannelId, content) {
  state.onceMessages = state.onceMessages || {}
  if (state.onceMessages[key]) return null
  const message = await sendDiscordMessage(content, targetChannelId)
  state.onceMessages[key] = { channelId: targetChannelId, messageId: message.id, sentAt: new Date().toISOString() }
  return message
}

async function discordJson(path, init = {}) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${token}`,
      'content-type': 'application/json',
      'user-agent': 'DiscordBot (https://sebcastwall.se, 0.1)',
      ...(init.headers || {})
    }
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`discord_${response.status}: ${payload.message || text.slice(0, 200)}`)
  return payload
}

function loadEnv(paths) {
  const result = { ...process.env }
  for (const path of paths) {
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const [key, ...rest] = trimmed.split('=')
      result[key] = rest.join('=')
    }
  }
  return result
}

function required(key) {
  const value = env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

function loadState() {
  if (!existsSync(statePath)) return { startedAt: null, postedActionIds: {}, postedSystemKeys: {}, messageToAction: {}, seenMessageIds: {}, dailyRunDates: {}, workspaceRunDates: {}, onceMessages: {} }
  try {
    return { postedSystemKeys: {}, messageToAction: {}, activeActionByWorkspace: {}, dailyRunDates: {}, workspaceRunDates: {}, onceMessages: {}, ...JSON.parse(readFileSync(statePath, 'utf8')) }
  } catch {
    return { startedAt: null, postedActionIds: {}, postedSystemKeys: {}, messageToAction: {}, seenMessageIds: {}, dailyRunDates: {}, workspaceRunDates: {}, onceMessages: {} }
  }
}

function saveState() {
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(event, payload = {}) {
  console.log(JSON.stringify({ event, ...payload, at: new Date().toISOString() }))
}

function logThrottled(key, intervalMs, event, payload = {}) {
  state.logThrottle = state.logThrottle || {}
  const previous = state.logThrottle[key]
  const now = Date.now()
  if (previous && now - Date.parse(previous) < intervalMs) return
  state.logThrottle[key] = new Date(now).toISOString()
  saveState()
  log(event, payload)
}

function parseWorkspaceChannels(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function channelForWorkspace(workspace) {
  const keys = [
    workspace?.id,
    workspace?.gscProperty,
    workspace?.repoFullName,
    slugify(workspace?.label || ''),
  ].filter(Boolean)
  for (const key of keys) {
    if (workspaceChannels[key]) return workspaceChannels[key]
  }
  if (defaultWorkspaceId && keys.includes(defaultWorkspaceId)) return channelId
  if (autoCreateWorkspaceChannels && guildId) {
    const created = await ensureWorkspaceChannel(workspace)
    if (created) {
      for (const key of keys) workspaceChannels[key] = created.id
      return created.id
    }
  }
  return Object.keys(workspaceChannels).length === 0 && !defaultWorkspaceId ? channelId : null
}

function workspaceForChannel(targetChannelId) {
  const keys = Object.entries(workspaceChannels)
    .filter(([, mappedChannelId]) => mappedChannelId === targetChannelId)
    .map(([key]) => key)
  if (!keys.length) return null
  const gscProperty = keys.find((key) => key.startsWith('sc-domain:'))
    || keys.find((key) => /^https?:\/\//i.test(key) && !key.includes('__'))
    || keys.find((key) => /^https?:\/\//i.test(key))
    || ''
  const repoFullName = keys.find((key) => /^[^\s/:]+\/[^\s/]+$/.test(key)) || ''
  const labelKey = keys.find((key) => !key.startsWith('sc-domain:') && !/^https?:\/\//i.test(key) && !key.includes('/')) || gscProperty || repoFullName || keys[0]
  const site = normalizeGscPropertyHost(gscProperty)
  return {
    id: `${gscProperty || labelKey}__${repoFullName || ''}__main`,
    label: site || labelKey,
    gscProperty: gscProperty || undefined,
    repoFullName: repoFullName || undefined,
    branch: 'main'
  }
}

function normalizeGscPropertyHost(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('sc-domain:')) return raw.replace(/^sc-domain:/, '')
  try { return new URL(raw).hostname.replace(/^www\./, '') } catch { return raw }
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

async function ensureWorkspaceChannel(workspace) {
  const name = workspaceChannelName(workspace)
  state.createdWorkspaceChannels = state.createdWorkspaceChannels || {}
  const cacheKey = workspace?.id || workspace?.gscProperty || name
  if (state.createdWorkspaceChannels[cacheKey]) return state.createdWorkspaceChannels[cacheKey]

  try {
    const existing = await discordJson(`/guilds/${guildId}/channels`)
    if (Array.isArray(existing)) {
      const channel = existing.find((item) => item?.type === 0 && item?.name === name)
      if (channel?.id) {
        state.createdWorkspaceChannels[cacheKey] = { id: channel.id, name }
        return state.createdWorkspaceChannels[cacheKey]
      }
    }
    const created = await discordJson(`/guilds/${guildId}/channels`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        type: 0,
        topic: `SEO Agent workspace: ${workspace?.label || workspace?.id || name}`
      })
    })
    if (created?.id) {
      state.createdWorkspaceChannels[cacheKey] = { id: created.id, name }
      await sendDiscordMessage(`Skapade workspace-kanal: #${name}`, channelId)
      return state.createdWorkspaceChannels[cacheKey]
    }
  } catch (error) {
    log('workspace_channel_create_failed', { workspace: workspace?.label || cacheKey, channel: name, error: error?.message || String(error) })
  }
  return null
}

function workspaceChannelName(workspace) {
  const label = workspace?.label || workspace?.gscProperty || workspace?.repoFullName || workspace?.id || 'workspace'
  const domain = String(label).match(/(?:sc-domain:)?([a-z0-9.-]+\.[a-z]{2,})/i)?.[1] || label
  return `seo-${slugify(domain).slice(0, 42) || 'workspace'}`
}
