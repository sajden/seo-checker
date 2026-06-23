#!/usr/bin/env node
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentRuntimeSnapshot } from './agent-brain.mjs'

const env = loadEnv(['/home/deploy/.hermes/.env', '/home/deploy/seo-agent-discord/.env'])
const DISCORD_API = 'https://discord.com/api/v10'
const token = required('DISCORD_BOT_TOKEN')
const channelId = required('DISCORD_CHANNEL_ID')
const allowedUserId = required('DISCORD_ALLOWED_USER_ID')
const platformApiUrl = (env.PLATFORM_API_URL || 'https://dashboard2-platform-api.sebastian-castwall.workers.dev').replace(/\/$/, '')
const platformToken = env.PLATFORM_API_TOKEN || ''
const seoRuntimeUrl = (env.SEO_RUNTIME_URL || 'http://127.0.0.1:1460').replace(/\/$/, '')
const googleAdsOauthRedirectUri = env.GOOGLE_ADS_OAUTH_REDIRECT_URI || 'http://localhost:1455/oauth/google-ads/callback'
const googleAdsOauthState = env.GOOGLE_ADS_OAUTH_STATE || 'seo-agent-google-ads-oauth'
const gscOauthRedirectUri = env.GSC_REDIRECT_URI || env.GOOGLE_SEARCH_CONSOLE_REDIRECT_URI || 'https://seo-api.sebcastwall.se/api/gsc/callback'
const gscOauthState = env.GSC_OAUTH_STATE || 'seo-agent-gsc-oauth'
const noVncUrl = env.SEO_AGENT_NOVNC_URL || 'https://gsc-browser-direct.sebcastwall.se/?resize=scale'
const noVncTunnelCommand = env.SEO_AGENT_NOVNC_TUNNEL_COMMAND || ''
const noVncAuthUser = env.SEO_AGENT_NOVNC_AUTH_USER || ''
const noVncAuthPassword = env.SEO_AGENT_NOVNC_AUTH_PASSWORD || ''
const pollMs = Number(env.SEO_AGENT_POLL_MS || '60000')
const dailyHourUtc = Number(env.SEO_AGENT_DAILY_HOUR_UTC || '4')
const runCheckEveryMs = Number(env.SEO_AGENT_RUN_CHECK_MS || '900000')
const integrationDoctorEveryMs = Number(env.SEO_AGENT_INTEGRATION_DOCTOR_MS || String(12 * 60 * 60 * 1000))
const gscIssueCheckEveryMs = Number(env.SEO_AGENT_GSC_ISSUE_CHECK_MS || String(6 * 60 * 60 * 1000))
const repoCommitSyncEveryMs = Number(env.SEO_AGENT_REPO_COMMIT_SYNC_MS || String(15 * 60 * 1000))
const repoCommitSyncLimit = Number(env.SEO_AGENT_REPO_COMMIT_SYNC_LIMIT || '8')
const activeActionReminderMs = Number(env.SEO_AGENT_ACTIVE_ACTION_REMINDER_MS || String(6 * 60 * 60 * 1000))
const staleRunningMs = Number(env.SEO_AGENT_STALE_RUNNING_MS || String(2 * 60 * 60 * 1000))
const staleQueuedApprovedMs = Number(env.SEO_AGENT_STALE_APPROVED_QUEUE_MS || String(36 * 60 * 60 * 1000))
const staleActiveActionMs = Number(env.SEO_AGENT_STALE_ACTIVE_ACTION_MS || String(2 * 60 * 60 * 1000))
const autonomousActiveBlockMs = Number(env.SEO_AGENT_AUTONOMOUS_ACTIVE_BLOCK_MS || String(15 * 60 * 1000))
const stalePlatformIncidentMs = Number(env.SEO_AGENT_STALE_PLATFORM_INCIDENT_MS || String(48 * 60 * 60 * 1000))
const workspaceChannels = parseWorkspaceChannels(env.SEO_AGENT_WORKSPACE_CHANNELS || '{}')
const defaultWorkspaceId = env.SEO_AGENT_DEFAULT_WORKSPACE_ID || ''
const guildId = env.DISCORD_GUILD_ID || ''
const autoCreateWorkspaceChannels = env.SEO_AGENT_AUTO_CREATE_CHANNELS !== 'false'
const automationEnabled = env.SEO_AGENT_AUTONOMY_ENABLED !== 'false'
const codeAutomationEnabled = env.SEO_AGENT_CODE_AUTOMATION_ENABLED === 'true'
const autonomousCodeEnabled = env.SEO_AGENT_AUTONOMOUS_CODE_ENABLED !== 'false'
const autonomousCodePerWorkspacePerDay = Number(env.SEO_AGENT_AUTONOMOUS_CODE_PER_WORKSPACE_PER_DAY || '0')
const opportunityScoutMinIntervalMs = Number(env.SEO_AGENT_OPPORTUNITY_SCOUT_MIN_INTERVAL_MS || String(3 * 60 * 60 * 1000))
const opportunityScoutGrowthMinIntervalMs = Number(env.SEO_AGENT_OPPORTUNITY_SCOUT_GROWTH_MIN_INTERVAL_MS || String(60 * 60 * 1000))
const opportunityScoutInvalidCooldownMs = Number(env.SEO_AGENT_OPPORTUNITY_SCOUT_INVALID_COOLDOWN_MS || String(3 * 60 * 60 * 1000))
const codexChatEnabled = env.SEO_AGENT_CODEX_CHAT_ENABLED !== 'false'
const smartOutboundGuardEnabled = env.SEO_AGENT_SMART_OUTBOUND_GUARD !== 'false'
const codexCli = env.CODEX_CLI || `${env.HOME || '/home/deploy'}/.npm-global/bin/codex`
const stateDir = '/home/deploy/seo-agent-discord/state'
const statePath = join(stateDir, 'state.json')
const agentSpecFiles = ['AGENTS.md', 'SKILLS.md', 'TOOLS.md', 'POLICIES.md', 'MEMORY.md']
const processStartedAtMs = Date.now()
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
const state = loadState()
ensureAutonomousAgentState()
let tickRunning = false
const runtimeLiveActionsCache = new Map()

log('starting', { channelId, allowedUserId, platformApiUrl, seoRuntimeUrl, pollMs, dailyHourUtc, runCheckEveryMs, workspaceChannelCount: Object.keys(workspaceChannels).length, automationEnabled, codeAutomationEnabled })
startDiscordInteractionClient()
await postStartupOnce()

while (true) {
  await tickGuarded().catch((error) => log('tick_failed', { error: error?.message || String(error) }))
  await sleep(pollMs)
}

async function tickGuarded() {
  if (tickRunning) {
    logThrottled('tick_skipped_overlap', 30 * 60 * 1000, 'tick_skipped_overlap', { reason: 'previous_tick_still_running' })
    return
  }
  tickRunning = true
  try {
    await tick()
  } finally {
    tickRunning = false
  }
}

async function tick() {
  cleanupStaleRuntimeState()
  const tickAdvice = await fetchRuntimeTickAdvice()
  const steps = tickAdvice?.steps || {}
  if (steps.processDiscordReplies !== false) {
    await runTickStep('process_discord_replies', () => processDiscordReplies())
  }
  const workspaces = await listWorkspaces().catch((error) => {
    recordTickStepFailure('list_workspaces', error)
    return null
  })
  if (!Array.isArray(workspaces)) {
    saveState()
    return
  }
  if (steps.syncWorkspaceRepoCommits !== false) await runTickStep('sync_workspace_repo_commits', () => syncWorkspaceRepoCommits(workspaces))
  if (steps.ensureDailyRunsForWorkspaces !== false) await runTickStep('ensure_daily_runs_for_workspaces', () => ensureDailyRunsForWorkspaces(workspaces))
  if (steps.runDailyRankingReviews !== false) await runTickStep('run_daily_ranking_reviews', () => runDailyRankingReviews(workspaces))
  if (steps.postReadinessForWorkspaces !== false) await runTickStep('post_readiness_for_workspaces', () => postReadinessForWorkspaces(workspaces))
  if (steps.checkGscIssuesForWorkspaces !== false) await runTickStep('check_gsc_issues_for_workspaces', () => checkGscIssuesForWorkspaces(workspaces))
  if (steps.postPendingActionsForWorkspaces !== false) await runTickStep('post_pending_actions_for_workspaces', () => postPendingActionsForWorkspaces(workspaces))
  if (steps.prepareAutonomousCodeWork !== false) await runTickStep('prepare_autonomous_code_work', () => maybePrepareAutonomousCodeWork(workspaces))
  if (steps.runIntegrationDoctor !== false) await runTickStep('run_integration_doctor', () => maybeRunIntegrationDoctor(workspaces))
  if (steps.askForGscApiOauth !== false) await runTickStep('ask_for_gsc_api_oauth', () => maybeAskForGscApiOAuth())
  saveState()
}

async function runTickStep(name, fn) {
  try {
    return await fn()
  } catch (error) {
    recordTickStepFailure(name, error)
    return null
  }
}

function recordTickStepFailure(name, error) {
  const message = error?.message || String(error)
  state.tickStepFailures = state.tickStepFailures || {}
  state.tickStepFailures[name] = {
    count: Number(state.tickStepFailures[name]?.count || 0) + 1,
    lastError: message.slice(0, 500),
    lastAt: new Date().toISOString()
  }
  logThrottled(`tick_step_failed:${name}:${message.slice(0, 120)}`, 15 * 60 * 1000, 'tick_step_failed', {
    step: name,
    error: message
  })
}

async function postStartupOnce() {
  if (state.startedAt) return
  state.startedAt = new Date().toISOString()
  await sendDiscordMessage('SEO Agent är online. Jag postar SEO-actions här med knappar och svarar som vanlig chat. Om något är oklart ställer jag följdfrågor innan jag gör ändringar.')
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

async function syncWorkspaceRepoCommits(workspaces) {
  if (!automationEnabled) return
  const now = Date.now()
  if (state.lastRepoCommitSyncAt && now - Date.parse(state.lastRepoCommitSyncAt) < repoCommitSyncEveryMs) return
  state.lastRepoCommitSyncAt = new Date(now).toISOString()
  state.repoCommitSync = state.repoCommitSync || {}
  for (const workspace of workspaces) {
    await syncWorkspaceRepoCommitsForWorkspace(workspace).catch((error) => {
      const key = workspaceProfileKey(workspace, null)
      state.repoCommitSync[key] = {
        ...(state.repoCommitSync[key] || {}),
        workspaceKey: key,
        repoFullName: workspace?.repoFullName || null,
        branch: workspace?.branch || 'main',
        checkedAt: new Date().toISOString(),
        status: 'failed',
        error: String(error?.message || error).slice(0, 500)
      }
      logThrottled(`repo_commit_sync_failed:${key}`, 6 * 60 * 60 * 1000, 'repo_commit_sync_failed', { workspace: workspace?.label || workspace?.id || key, error: error?.message || String(error) })
    })
  }
}

async function syncWorkspaceRepoCommitsForWorkspace(workspace) {
  const repoFullName = String(workspace?.repoFullName || '').trim()
  if (!repoFullName) return
  const branch = String(workspace?.branch || 'main').trim() || 'main'
  const repoDir = resolveRepoCheckoutDir(repoFullName)
  const key = workspaceProfileKey(workspace, null)
  const nowIso = new Date().toISOString()
  const previous = state.repoCommitSync?.[key] || {}
  if (!repoDir) {
    state.repoCommitSync[key] = {
      ...previous,
      workspaceKey: key,
      repoFullName,
      branch,
      checkedAt: nowIso,
      status: 'missing_checkout',
      error: `No checkout found for ${repoFullName}`
    }
    return
  }
  const git = await gitRunner(repoDir)
  await git(['fetch', '--quiet', 'origin', branch], 2 * 60 * 1000)
  const stdout = await git(['log', `--max-count=${repoCommitSyncLimit}`, '--format=%H%x09%h%x09%ct%x09%s', `origin/${branch}`], 60 * 1000)
  const commits = stdout.split(/\r?\n/)
    .map(parseGitLogLine)
    .filter(Boolean)
  const known = new Set([...(previous.knownShas || []), ...(previous.recentCommits || []).map((item) => item.sha)].filter(Boolean))
  for (const commit of commits.slice().reverse()) {
    if (known.has(commit.sha)) continue
    recordObservedRepoCommit(workspace, repoDir, commit)
    known.add(commit.sha)
  }
  state.repoCommitSync[key] = {
    workspaceKey: key,
    repoFullName,
    branch,
    repoDir,
    checkedAt: nowIso,
    status: 'ok',
    lastSeenSha: commits[0]?.sha || previous.lastSeenSha || null,
    recentCommits: commits.slice(0, repoCommitSyncLimit),
    knownShas: [...known].slice(-80)
  }
}

async function gitRunner(repoDir) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  return async (args, timeout = 60 * 1000) => {
    const result = await exec('git', args, {
      cwd: repoDir,
      env: { ...process.env, PATH: `/home/deploy/.npm-global/bin:/home/deploy/.local/bin:${process.env.PATH || ''}` },
      timeout,
      maxBuffer: 1024 * 1024
    })
    return String(result.stdout || '').trim()
  }
}

function parseGitLogLine(line) {
  const [sha, shortSha, timestamp, ...subjectParts] = String(line || '').split('\t')
  if (!sha || !shortSha) return null
  return {
    sha,
    shortSha,
    committedAt: Number(timestamp) ? new Date(Number(timestamp) * 1000).toISOString() : null,
    subject: subjectParts.join('\t').trim()
  }
}

function resolveRepoCheckoutDir(repoFullName) {
  const repoName = String(repoFullName || '').split('/').pop()
  if (!repoName) return ''
  const candidates = [
    `/home/deploy/seo-agent-workspaces/${repoName}`,
    `/mnt/HC_Volume_105954589/deploy-storage/agent-workspaces/seo-agent-workspaces/${repoName}`,
    `/mnt/HC_Volume_105954589/deploy-storage/agent-workspaces/${repoName}`
  ]
  return candidates.find((dir) => existsSync(join(dir, '.git'))) || ''
}

function recordObservedRepoCommit(workspace, repoDir, commit) {
  const workspaceKey = workspaceProfileKey(workspace, null)
  const key = `repo-commit:${workspaceKey}:${commit.shortSha}`
  const now = new Date().toISOString()
  const existing = state.actionLedger[key] || {}
  state.actionLedger[key] = {
    ...existing,
    key,
    actionId: key,
    title: `Repo commit: ${commit.subject || commit.shortSha}`,
    workspaceKey,
    targetUrl: null,
    keyword: null,
    status: 'observed',
    commit: commit.shortSha,
    repoFullName: workspace?.repoFullName || null,
    branch: workspace?.branch || 'main',
    repoDir,
    firstSeenAt: existing.firstSeenAt || now,
    lastEventAt: now,
    recheckAfter: existing.recheckAfter || defaultLedgerRecheck('completed', now),
    events: [
      { event: 'repo_commit_observed', at: now, commit: commit.shortSha, sha: commit.sha, subject: commit.subject, committedAt: commit.committedAt },
      ...(existing.events || [])
    ].slice(0, 20)
  }
  const profile = ensureWorkspaceProfile(workspace, null)
  const memory = Array.isArray(profile.memory) ? profile.memory : []
  const memoryItem = {
    at: now,
    source: 'repo_commit_sync',
    repoFullName: workspace?.repoFullName || null,
    branch: workspace?.branch || 'main',
    commit: commit.shortSha,
    subject: commit.subject || ''
  }
  profile.memory = [memoryItem, ...memory.filter((item) => item?.commit !== commit.shortSha)].slice(0, 30)
  profile.updatedAt = now
  state.workspaceProfiles[workspaceKey] = profile
  rememberAgentLesson(`Observed ${workspace?.label || workspaceKey} repo commit ${commit.shortSha}: ${commit.subject || 'no subject'}`)
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

async function checkGscIssuesForWorkspaces(workspaces) {
  if (!automationEnabled || !workspaces.length) return
  const now = Date.now()
  if (state.lastGscIssueCheckAt && now - Date.parse(state.lastGscIssueCheckAt) < gscIssueCheckEveryMs) return
  state.lastGscIssueCheckAt = new Date(now).toISOString()
  state.gscIssueFetchStatus = state.gscIssueFetchStatus || {}
  state.gscIssueSeen = state.gscIssueSeen || {}
  for (const workspace of workspaces) {
    const targetChannelId = await channelForWorkspace(workspace)
    if (!targetChannelId || !workspace?.gscProperty) continue
    const result = await fetchGscIssuesForWorkspace(workspace).catch((error) => ({ ok: false, issues: [], error: error?.message || String(error), source: null }))
    state.gscIssueFetchStatus[workspace.id || workspace.label || workspace.gscProperty] = {
      ok: result.ok,
      source: result.source || null,
      count: Array.isArray(result.issues) ? result.issues.length : 0,
      error: result.error || null,
      checkedAt: new Date().toISOString()
    }
    if (!result.ok) {
      logThrottled(`gsc_issue_fetch_unavailable:${workspace.id || workspace.label || workspace.gscProperty}`, 24 * 60 * 60 * 1000, 'gsc_issue_fetch_unavailable', {
        workspace: workspace.label || workspace.id,
        gscProperty: workspace.gscProperty,
        error: result.error || 'unknown'
      })
      continue
    }
    for (const rawIssue of result.issues.slice(0, 8)) {
      const issue = normalizeGscIssue(rawIssue, workspace)
      if (!issue) continue
      const action = createGscIssueAction(issue, workspace, targetChannelId, { source: result.source || 'gsc_issue_poll' })
      if (hasSeenGscIssueAction(action, workspace, issue)) continue
      await postGscIssueAction({ action, issue, workspace, targetChannelId, sourceLabel: `GSC issue hittad automatiskt (${result.source || 'platform'})` })
    }
  }
  pruneSeenGscIssues()
  saveState()
}

async function fetchGscIssuesForWorkspace(workspace) {
  const params = new URLSearchParams({
    gscProperty: workspace.gscProperty || '',
    repoFullName: workspace.repoFullName || '',
    branch: workspace.branch || 'main',
    limit: '25'
  })
  const paths = [
    `/api/platform/seo-monitor/gsc/issues?${params.toString()}`,
    `/api/platform/seo-monitor/gsc/indexing-issues?${params.toString()}`,
    `/api/platform/integrations/gsc/issues?${params.toString()}`
  ]
  const failures = []
  for (const path of paths) {
    try {
      const payload = await fetchPlatformJson(path)
      const issues = extractGscIssuesFromPayload(payload)
      return { ok: true, source: path.split('?')[0], issues }
    } catch (error) {
      failures.push(error?.message || String(error))
    }
  }
  return {
    ok: false,
    issues: [],
    source: null,
    error: failures.some((failure) => /platform_404/i.test(failure))
      ? 'no_gsc_issue_endpoint'
      : failures.slice(0, 2).join(' | ') || 'gsc_issue_fetch_failed'
  }
}

function extractGscIssuesFromPayload(payload) {
  const candidates = [
    payload?.issues,
    payload?.gscIssues,
    payload?.indexingIssues,
    payload?.coverageIssues,
    payload?.items,
    payload?.data?.issues,
    payload?.data?.items
  ]
  const found = candidates.find((value) => Array.isArray(value))
  return found || []
}

function normalizeGscIssue(rawIssue, workspace) {
  if (!rawIssue) return null
  if (typeof rawIssue === 'string') return parseGscIssueMessage(rawIssue)
  const text = [
    rawIssue.title,
    rawIssue.reason,
    rawIssue.issue,
    rawIssue.issueType,
    rawIssue.type,
    rawIssue.coverageState,
    rawIssue.verdict,
    rawIssue.status,
    rawIssue.message,
    rawIssue.description
  ].filter(Boolean).join(' ')
  const parsed = parseGscIssueMessage(text)
  if (parsed) {
    return {
      ...parsed,
      affectedUrl: rawIssue.affectedUrl || rawIssue.url || rawIssue.pageUrl || rawIssue.exampleUrl || parsed.affectedUrl || (workspaceHost(workspace) ? `https://${workspaceHost(workspace)}/` : '')
    }
  }
  if (!text.trim()) return null
  return {
    type: slugify(rawIssue.type || rawIssue.issueType || rawIssue.reason || rawIssue.title || 'gsc_indexing_issue'),
    title: `GSC: ${String(rawIssue.title || rawIssue.reason || rawIssue.issueType || 'Indexeringsfel').slice(0, 120)}`,
    severity: /error|invalid|blocked|excluded|duplicate|404|noindex/i.test(text) ? 'high' : 'medium',
    affectedUrl: rawIssue.affectedUrl || rawIssue.url || rawIssue.pageUrl || rawIssue.exampleUrl || (workspaceHost(workspace) ? `https://${workspaceHost(workspace)}/` : ''),
    reason: String(rawIssue.reason || rawIssue.message || rawIssue.description || text).slice(0, 500)
  }
}

async function postGscIssueAction({ action, issue, workspace, targetChannelId, sourceLabel }) {
  state.gscIssues = state.gscIssues || {}
  state.gscIssues[action.id] = {
    ...issue,
    actionId: action.id,
    workspaceId: workspace.id || null,
    workspaceLabel: workspace.label || null,
    channelId: targetChannelId,
    receivedAt: new Date().toISOString(),
    source: action.source || 'gsc_issue_poll'
  }
  ensureWorkspaceProfile(workspace, targetChannelId)
  const review = reviewActionForPosting(action, workspace, targetChannelId, sourceLabel)
  const message = await buildActionCardMessage(action, sourceLabel, workspace, review, targetChannelId)
  if (!message) return null
  const posted = await sendDiscordMessage(message, targetChannelId, actionComponents(action), { kind: 'action_card' })
  const activeKey = activeWorkspaceActionKey(workspace, targetChannelId)
  const runtimePosted = await markActionPostedThroughRuntime({
    action,
    workspace,
    targetChannelId,
    messageId: posted.id,
    activeKey,
    systemKey: gscIssueSeenKey(action, workspace, issue),
    guard: 'gsc_issue',
    review
  })
  if (!runtimePosted.ok) {
    state.postedActionIds = state.postedActionIds || {}
    state.postedActionIds[action.id] = {
      messageId: posted.id,
      channelId: targetChannelId,
      title: action.title,
      workspaceId: workspace.id || null,
      postedAt: new Date().toISOString()
    }
    state.activeActionByWorkspace = state.activeActionByWorkspace || {}
    state.activeActionByWorkspace[activeKey] = {
      actionId: action.id,
      messageId: posted.id,
      channelId: targetChannelId,
      workspaceId: workspace.id || null,
      firstPostedAt: new Date().toISOString(),
      postedAt: new Date().toISOString()
    }
    state.messageToAction = state.messageToAction || {}
    state.messageToAction[posted.id] = action.id
    recordActionLedger(action, workspace, targetChannelId, 'posted', { source: action.source || 'gsc_issue_poll', issueType: issue.type, messageId: posted.id, review })
  }
  rememberGscIssueAction(action, workspace, issue)
  rememberAgentLesson(`GSC issue action posted for ${workspace.label || workspace.id}: ${issue.type}`)
}

function hasSeenGscIssueAction(action, workspace, issue) {
  const key = gscIssueSeenKey(action, workspace, issue)
  const seenAt = state.gscIssueSeen?.[key]?.seenAt
  return Boolean(seenAt && Date.now() - Date.parse(seenAt) < 7 * 24 * 60 * 60 * 1000)
}

function rememberGscIssueAction(action, workspace, issue) {
  state.gscIssueSeen = state.gscIssueSeen || {}
  state.gscIssueSeen[gscIssueSeenKey(action, workspace, issue)] = {
    actionId: action.id,
    workspaceId: workspace?.id || null,
    title: action.title,
    seenAt: new Date().toISOString()
  }
}

function gscIssueSeenKey(action, workspace, issue) {
  return [
    workspace?.id || workspace?.gscProperty || workspace?.label || 'workspace',
    issue?.type || action?.category || 'gsc',
    normalizeActionPath(issue?.affectedUrl || action?.targetUrl || action?.url || '/')
  ].join(':')
}

function pruneSeenGscIssues() {
  const entries = Object.entries(state.gscIssueSeen || {})
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  state.gscIssueSeen = Object.fromEntries(entries.filter(([, value]) => {
    const seenAt = Date.parse(value?.seenAt || '')
    return seenAt && seenAt > cutoff
  }))
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
  await recoverRetryableCodeFailures(workspaces)
  const processedQueued = await processApprovedCodeActions(workspaces)
  if (processedQueued) return
  await maybeQueueAutonomousCodeActions(workspaces)
  await processApprovedCodeActions(workspaces)
}

async function maybeQueueAutonomousCodeActions(workspaces) {
  if (!automationEnabled || !autonomousCodeEnabled || !codeAutomationEnabled || state.codeActionRunning) return
  const today = new Date().toISOString().slice(0, 10)
  state.autonomousCodeRuns = state.autonomousCodeRuns || {}
  for (const workspace of workspaces) {
    const targetChannelId = await channelForWorkspace(workspace)
    if (!targetChannelId || !workspace.repoFullName) continue
    const repoReady = await repoAutomationReady(workspace.repoFullName, workspace.branch || 'main')
    if (!repoReady.ready) {
      logThrottled(`autonomous_repo_not_ready:${workspace.repoFullName}`, 60 * 60 * 1000, 'autonomous_repo_not_ready', {
        workspace: workspace.label || workspace.id || null,
        repoFullName: workspace.repoFullName,
        reason: repoReady.reason
      })
      continue
    }
    const runKey = `${workspace.id || workspace.label || workspace.repoFullName}:${today}`
    const usedToday = Number(state.autonomousCodeRuns[runKey]?.count || 0)
    if (autonomousCodePerWorkspacePerDay > 0 && usedToday >= autonomousCodePerWorkspacePerDay) {
      logThrottled(`autonomous_daily_limit:${runKey}`, 30 * 60 * 1000, 'autonomous_daily_limit', {
        workspace: workspace.label || workspace.id || null,
        usedToday,
        limit: autonomousCodePerWorkspacePerDay
      })
      continue
    }
    const active = activeActionRecordFor(workspace, targetChannelId)
    if (active?.actionId && activeActionBlocksAutonomousCode(active)) {
      logThrottled(`autonomous_active_card_block:${active.actionId}`, 30 * 60 * 1000, 'autonomous_active_card_block', {
        workspace: workspace.label || workspace.id || null,
        actionId: active.actionId
      })
      continue
    }
    if (active?.actionId) {
      delete state.activeActionByWorkspace[activeWorkspaceActionKey(workspace, targetChannelId)]
      recordActionLedger({ id: active.actionId }, workspace, targetChannelId, 'deprioritized', {
        reason: 'autonomous_active_card_timeout',
        recheckAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      })
      log('autonomous_active_card_timeout_cleared', { actionId: active.actionId, workspace: workspace.label || workspace.id || null })
    }
    const payload = await fetchActionsForChat(workspace).catch((error) => ({ error: error?.message || String(error), actions: [] }))
    const actions = Array.isArray(payload.actions) ? payload.actions : []
    const candidate = await chooseAutonomousCodeAction(actions, workspace, targetChannelId, payload.workspacePolicy, payload)
    if (!candidate) {
      logThrottled(`autonomous_no_candidate_tick:${workspace.id || workspace.label || workspace.repoFullName}`, 30 * 60 * 1000, 'autonomous_no_candidate_tick', {
        workspace: workspace.label || workspace.id || null,
        pendingCount: actions.filter((item) => item?.status === 'pending').length,
        error: payload.error || null
      })
      continue
    }
    if (autonomousCandidateAlreadyQueuedOrRunning(candidate.action, workspace, targetChannelId)) {
      logThrottled(`autonomous_candidate_already_inflight:${candidate.action.id}`, 30 * 60 * 1000, 'autonomous_candidate_already_inflight', {
        workspace: workspace.label || workspace.id || null,
        actionId: candidate.action.id
      })
      continue
    }
    state.approvedCodeActionQueue = state.approvedCodeActionQueue || {}
    state.approvedCodeActionQueue[candidate.action.id] = {
      ...candidate.action,
      id: candidate.action.id,
      repoFullName: workspace.repoFullName,
      branch: workspace.branch || candidate.action.branch || 'main',
      workspaceSlug: workspace.label || candidate.action.workspaceSlug || candidate.action.projectSlug || null,
      queuedAt: new Date().toISOString(),
      channelId: targetChannelId,
      autonomous: true,
      autonomousReason: candidate.reason
    }
    state.autonomousCodeRuns[runKey] = {
      count: usedToday + 1,
      lastActionId: candidate.action.id,
      lastQueuedAt: new Date().toISOString(),
      reason: candidate.reason
    }
    recordActionLedger(candidate.action, workspace, targetChannelId, 'approved', {
      source: 'autonomous_code',
      reason: candidate.reason,
      review: candidate.review,
      codexBrief: candidate.codexBrief
    })
    await markPostedActionHandled(candidate.action.id, targetChannelId, 'autonomous_code_queued')
    clearActiveAction(candidate.action.id)
    await sendDiscordMessage([
      `Autopilot startar en låg-risk SEO-fix för ${workspace.label}.`,
      `Kort: ${candidate.codexBrief?.title || candidate.action.title}`,
      candidate.action.targetUrl ? `URL: ${candidate.action.targetUrl}` : '',
      `Varför: ${candidate.reason}`,
      'Jag kodar, bygger, committar och postar diff/commit här. Jag frågar bara vid hög risk, ny sida, oklar riktning eller konflikt.'
    ].filter(Boolean).join('\n').slice(0, 1900), targetChannelId)
    saveState()
    return
  }
}

function autonomousCandidateAlreadyQueuedOrRunning(action, workspace, targetChannelId) {
  const actionId = action?.id
  if (!actionId) return true
  if (state.codeActionRunning?.actionId === actionId) return true
  if (state.approvedCodeActionQueue?.[actionId]) return true
  const workspaceKey = activeWorkspaceActionKey(workspace, targetChannelId)
  for (const queued of Object.values(state.approvedCodeActionQueue || {})) {
    if (!queued) continue
    if (queued.id === actionId) return true
    if ((queued.channelId || '') === targetChannelId) return true
    const queuedRepo = String(queued.repoFullName || '')
    if (queuedRepo && queuedRepo === String(workspace?.repoFullName || '')) return true
  }
  if (state.codeActionRunning?.workspaceKey === workspaceKey) return true
  return Object.values(state.actionLedger || {}).some((record) => {
    if (record?.actionId !== actionId) return false
    const last = Date.parse(record.lastEventAt || '')
    return Boolean(last && Date.now() - last < 10 * 60 * 1000 && ['approved', 'running'].includes(String(record.status || '')))
  })
}

function activeActionBlocksAutonomousCode(active) {
  const startedAt = Date.parse(active?.firstPostedAt || active?.postedAt || active?.repostedAt || active?.lastReminderAt || '')
  if (!startedAt) return false
  return Date.now() - startedAt < autonomousActiveBlockMs
}

function codeActionResultBlocks(action, workspace, targetChannelId) {
  const actionId = action?.id
  if (!actionId) return false
  if (codeActionLedgerCooldownBlocks(action)) return true
  const result = state.codeActionResults?.[actionId]
  if (!result) return false
  const status = String(result.status || '')
  if (status === 'archived_failed') return false
  if (codeActionSameIdCooldownBlocks(action)) return true
  const ledger = state.actionLedger?.[actionLearningKey(action, workspace, targetChannelId)]
  if (ledger?.recheckAfter) return !isLedgerRecheckDue(ledger)

  const terminalAt = result.completedAt || result.failedAt || result.archivedAt || ''
  const terminalMs = Date.parse(terminalAt)
  if (!terminalMs) return true
  const waitMs = status === 'completed'
    ? 14 * 24 * 60 * 60 * 1000
    : 7 * 24 * 60 * 60 * 1000
  return Date.now() - terminalMs < waitMs
}

function codeActionLedgerCooldownBlocks(action, cooldownMs = 24 * 60 * 60 * 1000) {
  const actionId = action?.id
  if (!actionId) return false
  const now = Date.now()
  for (const record of Object.values(state.actionLedger || {})) {
    if (record?.actionId !== actionId) continue
    const events = Array.isArray(record.events) ? record.events : []
    for (const event of events) {
      const name = String(event?.event || '')
      if (!['completed', 'deprioritized', 'failed', 'reverted'].includes(name)) continue
      const at = Date.parse(event?.at || '')
      if (at && now - at < cooldownMs) return true
    }
    const lastEventAt = Date.parse(record.lastEventAt || '')
    if (lastEventAt && now - lastEventAt < cooldownMs && ['completed', 'failed', 'deprioritized', 'reverted'].includes(String(record.status || ''))) {
      return true
    }
  }
  return false
}

function codeActionSameIdCooldownBlocks(action, cooldownMs = 24 * 60 * 60 * 1000) {
  const actionId = action?.id
  if (!actionId) return false
  const result = state.codeActionResults?.[actionId]
  if (!result) return false
  const terminalAt = result.completedAt || result.failedAt || result.archivedAt || ''
  const terminalMs = Date.parse(terminalAt)
  return Boolean(terminalMs && Date.now() - terminalMs < cooldownMs)
}

async function recoverRetryableCodeFailures(workspaces) {
  if (!automationEnabled || !autonomousCodeEnabled || !codeAutomationEnabled || state.codeActionRunning) return
  state.codeActionResults = state.codeActionResults || {}
  state.approvedCodeActionQueue = state.approvedCodeActionQueue || {}
  for (const [actionId, result] of Object.entries(state.codeActionResults)) {
    const failure = result?.failure || {}
    if (!['infra_failed'].includes(result?.status)) continue
    if (!failure.retryable || failure.category !== 'repo_access') continue
    if (state.approvedCodeActionQueue[actionId]) continue
    const failedAt = Date.parse(result.failedAt || '')
    if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) continue
    const workspace = workspaceForFailedAction(actionId, workspaces)
    if (!workspace?.repoFullName) continue
    const repoReady = await repoAutomationReady(workspace.repoFullName, workspace.branch || 'main')
    if (!repoReady.ready) continue
    const targetChannelId = await channelForWorkspace(workspace)
    const action = await actionForRetry(actionId, workspace, targetChannelId)
    if (!action || !isCodeAction(action)) continue
    delete state.codeActionResults[actionId]
    state.approvedCodeActionQueue[actionId] = {
      ...action,
      id: actionId,
      repoFullName: workspace.repoFullName,
      branch: workspace.branch || action.branch || 'main',
      workspaceSlug: workspace.label || action.workspaceSlug || action.projectSlug || null,
      queuedAt: new Date().toISOString(),
      channelId: targetChannelId,
      autonomous: true,
      retryAfterSelfRepair: true,
      autonomousReason: 'Tidigare kodaction stoppades av repo-access/checkout, men repo är redo nu.'
    }
    recordActionLedger(action, workspace, targetChannelId, 'approved', {
      source: 'retryable_failure_recovered',
      reason: 'repo_access_ready_after_failure'
    })
    await markPostedActionHandled(actionId, targetChannelId, 'retryable_failure_recovered')
    await sendDiscordMessage([
      `Jag återupptar en tidigare stoppad SEO-fix för ${workspace.label}.`,
      `Kort: ${action.title || actionId}`,
      'Orsak: repo-checkout/deploy access är redo nu, så jag kör kodautomation istället för att låta kortet fastna.'
    ].join('\n').slice(0, 1900), targetChannelId)
    saveState()
    return
  }
}

function workspaceForFailedAction(actionId, workspaces) {
  const lowered = String(actionId || '').toLowerCase()
  const ledger = Object.values(state.actionLedger || {}).find((item) => item?.actionId === actionId)
  return workspaces.find((workspace) => {
    const haystack = `${workspace.id || ''} ${workspace.label || ''} ${workspace.gscProperty || ''} ${workspace.repoFullName || ''}`.toLowerCase()
    return lowered.includes(slugify(workspaceHost(workspace))) || lowered.includes(slugify(workspace.label || '')) || (ledger?.workspaceKey && haystack.includes(String(ledger.workspaceKey).toLowerCase().split('__')[0]))
  }) || null
}

async function actionForRetry(actionId, workspace, targetChannelId) {
  const payload = await fetchActionsForChat(workspace).catch(() => ({ actions: [] }))
  const live = Array.isArray(payload.actions) ? payload.actions.find((item) => item?.id === actionId) : null
  if (live) return live
  const ledger = Object.values(state.actionLedger || {}).find((item) => item?.actionId === actionId)
  if (!ledger) return fallbackActionFromState(actionId, targetChannelId)
  return {
    id: actionId,
    title: ledger.title || actionId,
    targetUrl: ledger.targetUrl || null,
    url: ledger.targetUrl || null,
    keyword: ledger.keyword || null,
    recommendedAction: 'Återuppta tidigare godkänd låg-risk SEO-fix efter att repo-access/checkout reparerats.',
    why: 'Tidigare körning stoppades av infrafel, inte av SEO- eller buildfel.',
    priority: 'high',
    category: 'content',
    status: 'approved',
    workspaceSlug: workspace?.label || null,
    projectSlug: workspace?.repoFullName || null
  }
}

async function repoAutomationReady(repoFullName, branch = 'main') {
  const repoName = String(repoFullName || '').split('/')[1]
  if (!repoName) return { ready: false, reason: 'missing_repo_name' }
  const repoDir = `/home/deploy/seo-agent-workspaces/${repoName}`
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    if (!existsSync(join(repoDir, '.git'))) return { ready: false, reason: `repo_checkout_missing:${repoName}` }
    const envPath = { ...process.env, PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}` }
    const status = await exec('git', ['status', '--porcelain'], { cwd: repoDir, env: envPath, timeout: 60 * 1000, maxBuffer: 1024 * 1024 })
    const dirty = String(status.stdout || '').trim()
    if (dirty) return { ready: true, reason: `dirty_worktree_recoverable_by_runner:${repoName}` }
    await exec('git', ['fetch', 'origin', branch], { cwd: repoDir, env: envPath, timeout: 2 * 60 * 1000, maxBuffer: 1024 * 1024 })
    await exec('git', ['merge', '--ff-only', 'FETCH_HEAD'], { cwd: repoDir, env: envPath, timeout: 2 * 60 * 1000, maxBuffer: 1024 * 1024 })
    await exec('git', ['push', '--dry-run', 'origin', `HEAD:${branch}`], { cwd: repoDir, env: envPath, timeout: 2 * 60 * 1000, maxBuffer: 1024 * 1024 })
    return { ready: true, reason: 'ready' }
  } catch (error) {
    return { ready: false, reason: String(error?.stderr || error?.message || error).slice(0, 240) }
  }
}

async function chooseAutonomousCodeAction(actions, workspace, targetChannelId, workspacePolicy = '', sourcePayload = null) {
  const pending = prioritizeActionQueue(actions.filter((item) => item?.status === 'pending'), workspace, targetChannelId)
  const rejectionReasons = []
  for (const action of pending) {
    if (!action?.id) {
      rejectionReasons.push({ title: action?.title || 'untitled', reason: 'missing_action_id' })
      continue
    }
    if (codeActionResultBlocks(action, workspace, targetChannelId)) {
      rejectionReasons.push({ id: action.id, title: action.title || action.id, reason: `already_result:${state.codeActionResults[action.id]?.status || 'done'}` })
      continue
    }
    if (state.approvedCodeActionQueue?.[action.id]) {
      rejectionReasons.push({ id: action.id, title: action.title || action.id, reason: 'already_queued' })
      continue
    }
    const enrichedAction = await enrichActionWithKeywordMetrics(action)
    const candidateCheck = autonomousCodeCandidateCheck(enrichedAction, workspace, targetChannelId)
    if (!candidateCheck.ok) {
      rejectionReasons.push({ id: enrichedAction.id, title: enrichedAction.title || enrichedAction.id, reason: candidateCheck.reason })
      continue
    }
    const guard = shouldPostActionCard(enrichedAction, workspace, targetChannelId)
    if (!guard.ok) {
      rejectionReasons.push({ id: enrichedAction.id, title: enrichedAction.title || enrichedAction.id, reason: `guard:${guard.reason}` })
      continue
    }
    const review = reviewActionForPosting(enrichedAction, workspace, targetChannelId, workspacePolicy)
    if (!isAutonomousReviewSafe(review)) {
      rejectionReasons.push({ id: enrichedAction.id, title: enrichedAction.title || enrichedAction.id, reason: `review:${review?.recommendation || 'unknown'}:${Math.round(Number(review?.score || 0))}:${review?.risk || ''}` })
      continue
    }
    const codexBrief = await runCodexActionCardBrief({
      action: enrichedAction,
      workspace,
      workspacePolicy,
      review,
      targetChannelId
    }).catch((error) => {
      log('autonomous_codex_brief_failed', { actionId: enrichedAction.id, workspace: workspace?.label || workspace?.id || null, error: error?.message || String(error) })
      return null
    })
    if (!isAutonomousCodexSafe(codexBrief)) {
      rejectionReasons.push({ id: enrichedAction.id, title: enrichedAction.title || enrichedAction.id, reason: `codex:${codexBrief?.recommendation || codexBrief?.decision || 'blocked'}` })
      rememberCodexRejectedAction(enrichedAction, workspace, targetChannelId, codexBrief, 'autonomous_live_candidate')
      continue
    }
    return {
      action: enrichedAction,
      review,
      codexBrief,
      reason: codexBrief?.why || review.why || 'Codex och agentens guard bedömde detta som en konkret låg-risk förbättring.'
    }
  }
  const synthetic = await syntheticAutonomousActionForWorkspace({
    workspace,
    targetChannelId,
    pending,
    rejectionReasons,
    workspacePolicy,
    sourcePayload
  })
  if (synthetic) return synthetic
  rememberNoAutonomousCandidate(workspace, targetChannelId, pending, rejectionReasons)
  return null
}

function isAutonomousCodeCandidate(action, workspace, targetChannelId) {
  return autonomousCodeCandidateCheck(action, workspace, targetChannelId).ok
}

function autonomousCodeCandidateCheck(action, workspace, targetChannelId) {
  if (!isCodeAction(action)) return { ok: false, reason: 'not_code_action' }
  if (isIndexingCheckAction(action)) return { ok: false, reason: 'indexing_or_gsc_check' }
  const kind = actionKindForLearning(action)
  if (!['content', 'internal-links'].includes(kind)) return { ok: false, reason: `unsupported_kind:${kind}` }
  const targetUrl = String(action.targetUrl || action.url || '').trim()
  if (!targetUrl) return { ok: false, reason: 'missing_target_url' }
  if (isLegalOrPolicyRoute(targetUrl)) return { ok: false, reason: 'legal_or_policy_route_needs_explicit_request' }
  if (kind === 'new-page') return { ok: false, reason: 'new_page_needs_human_approval' }
  const cluster = actionLearningKey(action, workspace, targetChannelId)
  const ledger = state.actionLedger?.[cluster]
  if (ledger?.status === 'completed' && !isLedgerRecheckDue(ledger)) return { ok: false, reason: 'already_completed_waiting_recheck' }
  if (ledger?.status === 'deprioritized' && !isLedgerRecheckDue(ledger)) return { ok: false, reason: 'recently_deprioritized_waiting_recheck' }
  if (ledger?.status === 'ignored' && !isLedgerRecheckDue(ledger)) return { ok: false, reason: 'recently_ignored_waiting_recheck' }
  return { ok: true, reason: 'candidate' }
}

async function syntheticAutonomousActionForWorkspace({ workspace, targetChannelId, pending, rejectionReasons, workspacePolicy, sourcePayload = null }) {
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const hasGoodLiveCandidate = pending.some((action) => {
    const check = autonomousCodeCandidateCheck(action, workspace, targetChannelId)
    if (!check.ok) return false
    const review = reviewActionForPosting(action, workspace, targetChannelId, workspacePolicy)
    return isAutonomousReviewSafe(review)
  })
  const queueIsWeak = !pending.length || rejectionReasons.length >= Math.min(pending.length, 4)
  if (!queueIsWeak && hasGoodLiveCandidate) {
    logThrottled(`synthetic_autonomous_skipped:${workspace?.id || workspace?.label}:live`, 30 * 60 * 1000, 'synthetic_autonomous_skipped', { workspace: workspace?.label || workspace?.id || null, reason: 'good_live_candidate_available', pendingCount: pending.length })
    return null
  }
  const rawAction = buildWorkspaceGoalGapAction(workspace, targetChannelId, sourcePayload)
    || await buildCodexOpportunityAction(workspace, targetChannelId, {
      pending,
      rejectionReasons,
      workspacePolicy,
      sourcePayload
    }).catch((error) => {
      log('codex_opportunity_action_failed', { workspace: workspace?.label || workspace?.id || null, error: error?.message || String(error) })
      return null
    })
  if (!rawAction || codeActionResultBlocks(rawAction, workspace, targetChannelId) || state.approvedCodeActionQueue?.[rawAction.id]) {
    logThrottled(`synthetic_autonomous_skipped:${workspace?.id || workspace?.label}:empty`, 30 * 60 * 1000, 'synthetic_autonomous_skipped', { workspace: workspace?.label || workspace?.id || null, reason: !rawAction ? 'no_backlog_action' : 'already_result_or_queued', actionId: rawAction?.id || null })
    return null
  }
  const action = await enrichActionWithKeywordMetrics({
    ...rawAction,
    evidenceSource: sourcePayload?.batchId ? 'fresh_seo_run_plus_workspace_backlog' : 'workspace_goal_backlog',
    evidenceBatchId: sourcePayload?.batchId || null,
    evidenceRunAt: sourcePayload?.runAt || sourcePayload?.lastRunAt || sourcePayload?.batch?.lastRunAt || null,
    evidenceNote: sourcePayload?.batchId
      ? `Agent-skapad backlog validerad mot färsk SEO Monitor-batch ${sourcePayload.batchId}; ska ändå inte beskrivas som exakt GSC-query om actionen inte kommer direkt från live-actions.`
      : 'Agent-skapad backlog från workspace-mål och tidigare ledger; ska inte beskrivas som färsk GSC-query om live-data saknas.'
  })
  const candidateCheck = autonomousCodeCandidateCheck(action, workspace, targetChannelId)
  if (!candidateCheck.ok) {
    logThrottled(`synthetic_autonomous_skipped:${workspace?.id || workspace?.label}:${action.id}:candidate`, 30 * 60 * 1000, 'synthetic_autonomous_skipped', { workspace: workspace?.label || workspace?.id || null, actionId: action.id, reason: `candidate:${candidateCheck.reason}` })
    return null
  }
  const guard = shouldPostActionCard(action, workspace, targetChannelId)
  if (!guard.ok) {
    logThrottled(`synthetic_autonomous_skipped:${workspace?.id || workspace?.label}:${action.id}:guard`, 30 * 60 * 1000, 'synthetic_autonomous_skipped', { workspace: workspace?.label || workspace?.id || null, actionId: action.id, reason: `guard:${guard.reason}` })
    return null
  }
  const review = reviewActionForPosting(action, workspace, targetChannelId, workspacePolicy)
  if (!isAutonomousReviewSafe(review)) {
    logThrottled(`synthetic_autonomous_skipped:${workspace?.id || workspace?.label}:${action.id}:review`, 30 * 60 * 1000, 'synthetic_autonomous_skipped', { workspace: workspace?.label || workspace?.id || null, actionId: action.id, reason: `review:${review?.recommendation || 'unknown'}:${Math.round(Number(review?.score || 0))}:${review?.risk || ''}` })
    return null
  }
  const codexBrief = await runCodexActionCardBrief({
    action,
    workspace,
    workspacePolicy,
    review,
    targetChannelId
  }).catch((error) => {
    log('synthetic_autonomous_codex_brief_failed', { workspace: workspace?.label || workspace?.id || null, error: error?.message || String(error) })
    return null
  })
  if (!isAutonomousCodexSafe(codexBrief)) {
    logThrottled(`synthetic_autonomous_skipped:${workspace?.id || workspace?.label}:${action.id}:codex`, 30 * 60 * 1000, 'synthetic_autonomous_skipped', {
      workspace: workspace?.label || workspace?.id || null,
      actionId: action.id,
      reason: codexBrief ? `codex:${codexBrief.recommendation || codexBrief.decision || 'blocked'}` : 'codex:unavailable'
    })
    rememberCodexRejectedAction(action, workspace, targetChannelId, codexBrief, 'synthetic_autonomous_candidate')
    return null
  }
  log('synthetic_autonomous_action_selected', {
    workspace: workspace?.label || workspace?.id || null,
    actionId: action.id,
    rejectedLiveActions: rejectionReasons.slice(0, 8)
  })
  rememberAgentLesson(`Created synthetic ${profile.siteType || 'workspace'} goal-gap action because live queue did not provide a better low-risk code action.`)
  return {
    action,
    review,
    codexBrief,
    reason: codexBrief.why || syntheticEvidenceReason(action)
  }
}

function buildWorkspaceGoalGapAction(workspace, targetChannelId = null, sourcePayload = null) {
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const special = isSebcastwallWorkspace(workspace, profile) ? buildSebcastwallGoalGapAction(workspace, targetChannelId) : null
  if (special) return special
  const keywordMap = ensureKeywordMap(workspace, targetChannelId)
    .filter((item) => item?.status !== 'done' && item?.status !== 'paused')
    .filter((item) => item?.keyword && item?.targetUrl)
    .sort((a, b) => keywordPriorityWeight(a.priority) - keywordPriorityWeight(b.priority))
  const host = workspaceHost(workspace) || slugify(workspace?.label || workspace?.repoFullName || 'workspace')
  const repo = workspace?.repoFullName || 'repo'
  for (const item of keywordMap) {
    const action = buildKeywordMapSyntheticAction({ workspace, profile, keywordTarget: item, host, repo, sourcePayload })
    const cluster = actionLearningKey(action, workspace, targetChannelId)
    const ledger = state.actionLedger?.[cluster]
    if (codeActionResultBlocks(action, workspace, targetChannelId) || state.approvedCodeActionQueue?.[action.id]) continue
    if (ledger?.status === 'completed' && !isLedgerRecheckDue(ledger)) continue
    if (ledger?.status === 'ignored' && !isLedgerRecheckDue(ledger)) continue
    if (ledger?.status === 'deprioritized' && !isLedgerRecheckDue(ledger)) continue
    return action
  }
  return null
}

async function buildCodexOpportunityAction(workspace, targetChannelId = null, context = {}) {
  if (!codexChatEnabled) return null
  const repoFullName = String(workspace?.repoFullName || '').trim()
  const repoName = repoFullName.split('/')[1]
  if (!repoName) return null
  const repoDir = resolveRepoCheckoutDir(repoFullName)
  if (!repoDir) return null
  const key = workspaceProfileKey(workspace, targetChannelId)
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const previousScout = state.codexOpportunityScout?.[key]
  const previousInvalidScoutAt = Date.parse(previousScout?.at || '')
  const previousInvalidScoutAgeMs = Number.isFinite(previousInvalidScoutAt) ? Date.now() - previousInvalidScoutAt : Infinity
  if (previousScout?.blockedReason && previousInvalidScoutAgeMs >= 0 && previousInvalidScoutAgeMs < opportunityScoutInvalidCooldownMs) {
    logThrottled(`codex_opportunity_skipped:${key}:blocked`, 60 * 60 * 1000, 'codex_opportunity_skipped', {
      workspace: workspace?.label || workspace?.id || null,
      reason: previousScout.blockedReason || 'recent_invalid_scout',
      ageMinutes: Math.round(previousInvalidScoutAgeMs / 60000),
      minIntervalMinutes: Math.round(opportunityScoutInvalidCooldownMs / 60000)
    })
    return null
  }
  const previousScoutAt = Date.parse(previousScout?.at || 0)
  const scoutAgeMs = Number.isFinite(previousScoutAt) ? Date.now() - previousScoutAt : Infinity
  const scoutMinIntervalMs = opportunityScoutIntervalForWorkspace(profile, context)
  if (scoutAgeMs >= 0 && scoutAgeMs < scoutMinIntervalMs) {
    logThrottled(`codex_opportunity_skipped:${key}:recent`, 60 * 60 * 1000, 'codex_opportunity_skipped', {
      workspace: workspace?.label || workspace?.id || null,
      reason: 'recently_scouted',
      ageMinutes: Math.round(scoutAgeMs / 60000),
      minIntervalMinutes: Math.round(scoutMinIntervalMs / 60000)
    })
    return null
  }
  const keywordMap = ensureKeywordMap(workspace, targetChannelId)
  const learningSummary = buildWorkspaceLearningSummary(key)
  const experiments = Object.values(state.seoExperiments || {})
    .filter((item) => item.workspaceKey === key)
    .sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))
    .slice(0, 20)
  const recentCodeResults = recentCodeResultsForWorkspace(workspace, targetChannelId)
  const promptPath = join(stateDir, `codex-opportunity-${slugify(key).slice(0, 80)}.md`)
  const contextJson = {
    workspace: {
      id: workspace?.id,
      label: workspace?.label,
      gscProperty: workspace?.gscProperty,
      repoFullName,
      branch: workspace?.branch || 'main'
    },
    profile,
    keywordMap: keywordMap.slice(0, 20),
    recentExperiments: experiments.map((item) => ({
      title: item.title,
      targetUrl: item.targetUrl,
      keyword: item.keyword,
      commit: item.commit,
      completedAt: item.completedAt,
      reviewAfter: item.reviewAfter
    })),
    recentCodeResults,
    learningSummary,
    rejectedLiveActions: (context.rejectionReasons || []).slice(0, 12),
    workspacePolicy: context.workspacePolicy || '',
    source: {
      batchId: context.sourcePayload?.batchId || null,
      runAt: context.sourcePayload?.runAt || context.sourcePayload?.lastRunAt || null
    }
  }
  const prompt = [
    'Du är SEO Agentens opportunity scout.',
    'Inspektera repo-checkouten och skapa exakt EN låg-risk SEO-kodaction för en befintlig sida, eller returnera null om inget bra finns.',
    '',
    'Regler:',
    '- Returnera ENDAST JSON.',
    '- Välj bara en befintlig sida/route som verkar finnas i repo.',
    '- Skapa inte ny sida. Om bästa idén är en ny route, ny landningssida, dashboard/adminyta eller research/new-page: returnera action=null.',
    '- TargetUrl måste matcha en befintlig route från repo hints. Föreslå inte URL:er som inte redan finns.',
    '- Läs den tänkta målfilen innan du returnerar action. Om recommendedAction redan finns i filen: returnera action=null eller välj en annan befintlig sida.',
    '- Välj inte auth, GSC, privacy, terms eller rent tekniskt driftarbete.',
    '- Repetera inte recentExperiments innan reviewAfter, om inte hypotesen är tydligt annorlunda.',
    '- Repetera aldrig recentCodeResults med status no_changes, completed, build_failed eller failed utan en tydligt ny hypotes och annan konkret ändringsyta.',
    '- Använd learningSummary: undvik mönster som needs_more_work utan ny vinkel, och prioritera mönster som provisionally_improved när de passar dagens mål.',
    '- Kandidaten måste ha targetUrl, keyword/focus, problem, hypotes och konkret repoändring.',
    '- Workspace-profilen styr målgrupp och språk. Vägkollen får aldrig SMB/B2B/konsultspråk.',
    '',
    'JSON-format vid bra kandidat:',
    '{"action":{"title":"kort titel","targetUrl":"https://...","keyword":"sökfras/fokus","priority":"high|medium","category":"content|internal-links","why":"varför detta är bästa nästa experimentet","recommendedAction":"exakt vad kodaren ska ändra i repo"}}',
    '',
    'JSON-format om ingen kandidat finns:',
    '{"action":null,"reason":"kort varför"}',
    '',
    'AGENT SPEC:',
    readAgentSpecs(5000),
    '',
    'CONTEXT JSON:',
    JSON.stringify(contextJson, null, 2),
    '',
    'Repo hints:',
    await repoPageInventory(repoDir)
  ].join('\n')
  writeFileSync(promptPath, prompt)
  const result = await execCodexTracked({
    agent: 'seo-agent',
    purpose: 'opportunity_scout',
    workspace: workspace?.label || workspace?.id || null,
    command: `${codexCli} exec --json --cd ${repoDir} --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`,
    timeout: 4 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024
  })
  state.codexOpportunityScout = state.codexOpportunityScout || {}
  state.codexOpportunityScout[key] = { at: new Date().toISOString() }
  const output = extractCodexExecText(result.stdout || '')
  const parsed = parseCodexOpportunity(output)
  if (!parsed?.action) {
    log('codex_opportunity_no_action', { workspace: workspace?.label || workspace?.id || null, reason: parsed?.reason || 'no_action' })
    return null
  }
  const host = workspaceHost(workspace) || slugify(workspace?.label || repoName)
  const targetUrl = String(parsed.action.targetUrl || '').trim()
  const keyword = String(parsed.action.keyword || parsed.action.focus || '').trim()
  if (!targetUrl || !keyword) return null
  const candidateText = normalizeForMatch([
    parsed.action.title,
    parsed.action.category,
    parsed.action.why,
    parsed.action.recommendedAction,
    targetUrl,
    keyword
  ].filter(Boolean).join(' '))
  if (/new-page|ny-sida|ny-landningssida|skapa-ny|ny-route|dashboard|adminyta|research-new-page/.test(candidateText)) {
    state.codexOpportunityScout[key] = {
      at: new Date().toISOString(),
      blockedReason: 'scout_suggested_new_page_or_admin_surface'
    }
    rememberAgentLesson(`Codex opportunity scout suggested a new page or admin surface for ${workspace?.label || workspace?.id || key}; retry later with stricter existing-page instructions instead of blocking the workspace for days.`)
    log('codex_opportunity_invalid_action', {
      workspace: workspace?.label || workspace?.id || null,
      reason: 'scout_suggested_new_page_or_admin_surface',
      title: parsed.action.title || null,
      targetUrl
    })
    return null
  }
  return {
    id: `seo_scout_${slugify(`${host}-${repoName}-${normalizeActionPath(targetUrl)}-${keyword}`).slice(0, 140)}`,
    status: 'pending',
    priority: ['high', 'medium', 'low'].includes(parsed.action.priority) ? parsed.action.priority : 'high',
    category: ['content', 'internal-links'].includes(parsed.action.category) ? parsed.action.category : 'content',
    workspaceSlug: workspace?.label || host,
    projectSlug: repoFullName,
    synthetic: true,
    scout: true,
    title: String(parsed.action.title || `Scout: förbättra ${normalizeActionPath(targetUrl) || targetUrl}`).slice(0, 180),
    targetUrl,
    url: targetUrl,
    keyword,
    why: String(parsed.action.why || 'Codex scout hittade en låg-risk befintlig-sida-opportunity i repo när live-kön var svag.').slice(0, 900),
    recommendedAction: String(parsed.action.recommendedAction || '').slice(0, 1400),
    evidenceSource: context.sourcePayload?.batchId ? 'fresh_seo_run_plus_codex_repo_scout' : 'codex_repo_scout',
    evidenceBatchId: context.sourcePayload?.batchId || null,
    evidenceRunAt: context.sourcePayload?.runAt || context.sourcePayload?.lastRunAt || null
  }
}

async function repoPageInventory(repoDir) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execLocal = promisify(execFile)
  const commands = [
    ['bash', ['-lc', 'find . -path "*/node_modules" -prune -o -path "*/.next" -prune -o -path "*/dist" -prune -o \\( -name "page.tsx" -o -name "page.ts" -o -name "*.astro" -o -name "*.mdx" \\) -print | head -80']],
    ['bash', ['-lc', 'git log --oneline -12']]
  ]
  const parts = []
  for (const [cmd, args] of commands) {
    try {
      const result = await execLocal(cmd, args, { cwd: repoDir, timeout: 30 * 1000, maxBuffer: 512 * 1024 })
      parts.push(result.stdout.trim())
    } catch (error) {
      parts.push(`inventory_error: ${error?.message || String(error)}`)
    }
  }
  return parts.filter(Boolean).join('\n\n').slice(0, 6000)
}

function parseCodexOpportunity(text) {
  const raw = String(text || '').trim()
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw
  try {
    const parsed = JSON.parse(jsonText)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function opportunityScoutIntervalForWorkspace(profile, context = {}) {
  const rejected = Array.isArray(context.rejectionReasons) ? context.rejectionReasons : []
  const weakQueue = !rejected.length || rejected.length >= 4 || rejected.some((item) => /already_result|missing_target_url|not_code_action|guard:|recently/i.test(String(item?.reason || '')))
  if (profile?.siteType === 'ai_consultancy' && weakQueue) return opportunityScoutGrowthMinIntervalMs
  return opportunityScoutMinIntervalMs
}

function keywordPriorityWeight(priority) {
  return priority === 'critical' ? 0 : priority === 'high' ? 1 : priority === 'medium' ? 2 : 3
}

function buildKeywordMapSyntheticAction({ workspace, profile, keywordTarget, host, repo, sourcePayload = null }) {
  const keyword = String(keywordTarget.keyword || '').trim()
  const targetUrl = String(keywordTarget.targetUrl || '').trim()
  const siteType = profile?.siteType || 'service'
  const id = `seo_synthetic_${slugify(`${host}-${repo}-${normalizeActionPath(targetUrl)}-${keyword}`).slice(0, 130)}`
  return {
    id,
    status: 'pending',
    priority: keywordTarget.priority || 'high',
    category: 'content',
    workspaceSlug: workspace?.label || host,
    projectSlug: repo,
    synthetic: true,
    title: syntheticActionTitle(siteType, targetUrl, keyword),
    targetUrl,
    url: targetUrl,
    keyword,
    why: syntheticActionWhy(profile, keywordTarget, sourcePayload),
    recommendedAction: syntheticRecommendedAction(profile, keywordTarget)
  }
}

function syntheticActionTitle(siteType, targetUrl, keyword) {
  const path = normalizeActionPath(targetUrl) || '/'
  if (siteType === 'parking_service') return `Workspace goal gap: stärk ${path} för "${keyword}"`
  if (siteType === 'road_weather_utility') return `Workspace goal gap: stärk väg-/väderintention på ${path}`
  if (siteType === 'event_directory') return `Workspace goal gap: stärk eventintention på ${path}`
  if (siteType === 'ai_consultancy') return `Workspace goal gap: stärk tjänstesidan för "${keyword}"`
  return `Workspace goal gap: stärk ${path} för "${keyword}"`
}

function syntheticActionWhy(profile, keywordTarget, sourcePayload = null) {
  const fresh = sourcePayload?.batchId ? `Dagens SEO Monitor-batch ${sourcePayload.batchId} finns, men live-kön gav ingen bättre låg-risk kodaction.` : 'Live-kön gav ingen bättre låg-risk kodaction.'
  const target = keywordTarget.targetUrl ? `Målet "${keywordTarget.keyword}" är kopplat till ${keywordTarget.targetUrl}.` : `Målet är "${keywordTarget.keyword}".`
  return `${fresh} ${target} Workspace-profilen säger att detta är viktigt för ${profile?.siteType || 'sajten'}, så agenten väljer ett litet befintlig-sida-experiment som kan följas upp senare.`
}

function syntheticRecommendedAction(profile, keywordTarget) {
  const keyword = keywordTarget.keyword
  const targetUrl = keywordTarget.targetUrl
  if (profile?.siteType === 'parking_service') {
    return `I repo: uppdatera befintlig sida ${targetUrl} med tydligare parkeringserbjudande runt "${keyword}": konkreta användarscenarion, område/avstånd/pris/tid, trygghet, bokningsnästa steg, kort FAQ och interna länkar till relevanta parkeringssidor. Undvik B2B/SMB/AI-konsultspråk.`
  }
  if (profile?.siteType === 'road_weather_utility') {
    return `I repo: uppdatera befintlig sida ${targetUrl} runt "${keyword}" med konkreta bilrese-scenarion, vägväder/trafik/rutt-kontext, när tjänsten ska användas, risker som halka/regn/vind och tydliga interna länkar. Undvik generisk SaaS- eller konsultcopy.`
  }
  if (profile?.siteType === 'event_directory') {
    return `I repo: uppdatera befintlig sida ${targetUrl} runt "${keyword}" med tydlig eventintention: vilka event sidan hjälper med, målgrupp, stad/kategori-exempel, hur användaren hittar rätt event och interna länkar till relevanta kluster.`
  }
  if (profile?.siteType === 'ai_consultancy') {
    return `I repo: uppdatera befintlig sida ${targetUrl} runt "${keyword}" med tydligare köparproblem, konkreta case, leveransform, risker, proof, internlänkar och CTA. Håll fokus på AI, kod, automation och praktiska resultat.`
  }
  return `I repo: uppdatera befintlig sida ${targetUrl} runt "${keyword}" med mer konkret hjälpsamt innehåll, internlänkar, FAQ och tydligare nästa steg.`
}

function syntheticEvidenceReason(action) {
  const metrics = action?.keywordMetrics && typeof action.keywordMetrics === 'object' ? action.keywordMetrics : null
  const freshBatch = action?.evidenceSource === 'fresh_seo_run_plus_workspace_backlog'
  if (metrics && Number(metrics.avgMonthlySearches || 0) > 0) {
    return `Agenten valde en låg-risk befintlig-sida-ändring från ${freshBatch ? 'dagens SEO-run och workspace-backlog' : 'workspace-backloggen'} och Keyword Planner visar ${metrics.avgMonthlySearches} sök/mån för "${action.keyword}".`
  }
  if (action?.keywordMetricsStatus === 'failed') {
    return `Agenten valde en låg-risk befintlig-sida-ändring från ${freshBatch ? 'dagens SEO-run och workspace-backlog' : 'workspace-backloggen'}. Keyword Planner kunde inte verifieras (${action.keywordMetricsError || 'okänt fel'}), så detta är inte verifierad keyword-volym.`
  }
  return freshBatch
    ? 'Agenten valde en låg-risk befintlig-sida-ändring efter dagens SEO-run och tidigare ledger, men utan verifierad Keyword Planner-volym.'
    : 'Agenten valde en låg-risk befintlig-sida-ändring från workspace-mål och tidigare ledger. Detta är strategisk fallback, inte färsk GSC/Keyword Planner-evidens.'
}

function buildSebcastwallGoalGapAction(workspace, targetChannelId = null) {
  const host = workspaceHost(workspace) || 'sebcastwall.se'
  const repo = workspace?.repoFullName || 'repo'
  const base = {
    status: 'pending',
    priority: 'high',
    category: 'content',
    workspaceSlug: workspace?.label || host,
    projectSlug: repo,
    synthetic: true
  }
  const candidates = [
    {
      slug: 'autonomous-ai-training-service-gap',
      title: 'Workspace goal gap: stärk AI-automatisering med utbildning och kodnära konsultvinkel',
      targetUrl: 'https://sebcastwall.se/tjanster/ai-automatisering',
      keyword: 'AI automatisering företag',
      why: 'Sebcastwall-målet är AI-konsult, kodning, automation och AI-utbildningar. Nuvarande live-kö domineras av GSC/integrationer eller redan hanterade kort, så nästa låg-risk steg är att stärka befintlig AI-automatiseringssida mot köpintention.',
      recommendedAction: 'I repo: uppdatera /tjanster/ai-automatisering med tydligare erbjudande för AI-automatisering för företag, workshops/utbildning, konkreta kodnära exempel, interna länkar till AI-agenter, app-webbutveckling och interna verktyg, samt CTA för AI-konsultation. Skapa ingen ny sida utan tydligt behov.'
    },
    {
      slug: 'autonomous-apputveckling-company-intent',
      title: 'Workspace goal gap: stärk app/webbutveckling mot köpintention',
      targetUrl: 'https://sebcastwall.se/tjanster/app-webbutveckling',
      keyword: 'apputveckling företag',
      why: 'Sebcastwall ska vinna leads inom AI, kodning och app/web. När live-kön är svag är en låg-risk förbättring att göra befintlig app/webbutvecklingssida tydligare för företag som söker en utvecklingspartner.',
      recommendedAction: 'I repo: uppdatera /tjanster/app-webbutveckling med tydligare positionering för apputveckling för företag, exempel på AI-funktioner, interna verktyg, automation, leveransprocess, riskreducering, proof och interna länkar till AI-agenter och AI-automatisering. Skapa ingen ny sida.'
    },
    {
      slug: 'autonomous-ai-agents-internal-tools',
      title: 'Workspace goal gap: stärk AI-agenter för interna verktyg',
      targetUrl: 'https://sebcastwall.se/tjanster/ai-agenter',
      keyword: 'AI agenter företag',
      why: 'Sebcastwall ska äga AI-agent/kod/automation-spåret. Befintlig AI-agentsida kan förbättras mot konkreta interna arbetsflöden istället för generisk AI-copy.',
      recommendedAction: 'I repo: uppdatera /tjanster/ai-agenter med konkreta interna agentflöden för företag, exempel på research, support, CRM/fakturaflöden utan att bli bokföringsfokuserad, mänsklig kontroll, logging, säkerhet, ROI och interna länkar till app/webbutveckling och AI-automatisering.'
    },
    {
      slug: 'growth-ai-training-workshops',
      title: 'Growth gap: stärk AI-utbildning mot workshops och team',
      targetUrl: 'https://sebcastwall.se/tjanster/ai-utbildning',
      keyword: 'AI workshop företag',
      why: 'Sebcastwall har svag SEO och bör tydligare äga AI-utbildning/workshop-spåret. Detta är en befintlig tjänstesida med kommersiell intent och låg risk.',
      recommendedAction: 'I repo: uppdatera /tjanster/ai-utbildning med tydligare workshop-erbjudande för företag/team, exempel på upplägg, målgrupper, praktiska kod/AI-agent-övningar, beslutsstöd, FAQ och CTA. Länka till AI-agenter, AI-automatisering och app/webbutveckling där det stärker köpresan.'
    },
    {
      slug: 'growth-internal-ai-tools',
      title: 'Growth gap: stärk interna verktyg som AI-konsultcase',
      targetUrl: 'https://sebcastwall.se/tjanster/interna-verktyg',
      keyword: 'AI interna verktyg',
      why: 'Sebcastwall ska ranka för AI, kodning och interna verktyg. Befintlig sida för interna verktyg kan kopplas hårdare till AI-agenter och automation utan att bli integrationsspår.',
      recommendedAction: 'I repo: uppdatera /tjanster/interna-verktyg med konkreta AI-drivna interna verktyg: researchpaneler, ärendehantering, rapportflöden, datakopplingar, behörigheter och loggar. Lägg till internlänkar till AI-agenter och AI-automatisering samt tydlig CTA för AI-konsultation.'
    },
    {
      slug: 'growth-ai-services-hub',
      title: 'Growth gap: gör tjänstehubben tydligare för AI-tjänster',
      targetUrl: 'https://sebcastwall.se/tjanster',
      keyword: 'AI tjänster företag',
      why: 'När SEO:n är svag behöver tjänstehubben fördela intern auktoritet till de kommersiella AI-sidorna och göra erbjudandet lättare att förstå.',
      recommendedAction: 'I repo: uppdatera /tjanster med tydligare hubb för AI-tjänster: AI-konsult, AI-agenter, AI-automatisering, AI-utbildning, app/web och interna verktyg. Lägg korta köpscenarion, jämförelse mellan tjänsterna och starka interna länkar.'
    },
    {
      slug: 'growth-ai-internal-linking',
      title: 'Growth gap: stärk internlänkning mellan AI-sidor',
      targetUrl: 'https://sebcastwall.se/',
      keyword: 'AI konsult företag',
      category: 'internal-links',
      why: 'Sebcastwall behöver snabbare bygga topical authority runt AI-konsult, AI-utbildning och AI-agenter. Internlänkar från startsida och relevanta artiklar är låg risk och kan stödja de kommersiella sidorna.',
      recommendedAction: 'I repo: lägg in eller förbättra interna länkar från startsidan och relevanta artiklar till /tjanster/ai-agenter, /tjanster/ai-automatisering, /tjanster/ai-utbildning och /tjanster/interna-verktyg. Använd naturliga ankartexter som AI-konsult för företag, AI-agenter för företag, AI-utbildning för team och interna AI-verktyg. Ändra inte integration-only-sidor om det inte direkt stödjer AI-spåret.'
    },
    {
      slug: 'growth-chatgpt-for-business',
      title: 'Growth gap: stärk ChatGPT-artikeln mot företagsintent',
      targetUrl: 'https://sebcastwall.se/artiklar/chatgpt-for-foretag-kanslig-data',
      keyword: 'ChatGPT för företag',
      why: 'Artikeln kan fånga informationsintent runt ChatGPT i företag och länka vidare till AI-utbildning, AI-agenter och säker automation.',
      recommendedAction: 'I repo: uppdatera artikeln om ChatGPT för företag med tydligare praktiska scenarion, risker kring känslig data, policy/checklista, när man behöver AI-utbildning eller egen agentlösning, samt interna länkar till AI-utbildning, AI-agenter och AI-automatisering.'
    }
  ]
  for (const candidate of candidates) {
    const action = {
      ...base,
      ...candidate,
      id: `seo_synthetic_${slugify(`${host}-${repo}-${candidate.slug}`).slice(0, 120)}`,
      url: candidate.targetUrl
    }
    if (codeActionResultBlocks(action, workspace, targetChannelId) || state.approvedCodeActionQueue?.[action.id]) continue
    const cluster = actionLearningKey(action, workspace, targetChannelId)
    const ledger = state.actionLedger?.[cluster]
    if (ledger?.status === 'completed' && !isLedgerRecheckDue(ledger)) continue
    if (ledger?.status === 'ignored' && !isLedgerRecheckDue(ledger)) continue
    if (ledger?.status === 'deprioritized' && !isLedgerRecheckDue(ledger)) continue
    return action
  }
  return null
}

function isSebcastwallWorkspace(workspace, profile = null) {
  return [workspace?.label, workspace?.id, workspace?.gscProperty, workspace?.repoFullName, profile?.label]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes('sebcastwall'))
}

function rememberNoAutonomousCandidate(workspace, targetChannelId, pending, rejectionReasons) {
  const key = workspaceProfileKey(workspace, targetChannelId)
  state.noAutonomousCandidate = state.noAutonomousCandidate || {}
  const now = new Date().toISOString()
  state.noAutonomousCandidate[key] = {
    at: now,
    pendingCount: pending.length,
    reasons: rejectionReasons.slice(0, 12)
  }
  logThrottled(`no_autonomous_candidate:${key}`, 6 * 60 * 60 * 1000, 'no_autonomous_candidate', {
    workspace: workspace?.label || workspace?.id || null,
    pendingCount: pending.length,
    reasons: rejectionReasons.slice(0, 8)
  })
}

function isAutonomousReviewSafe(review) {
  if (!review?.ok) return false
  if (review.recommendation !== 'Approve') return false
  if (Number(review.score || 0) < 78) return false
  return /^låg\b/i.test(String(review.risk || ''))
}

function isAutonomousCodexSafe(codexBrief) {
  if (!codexBrief) return false
  if (!['allow', 'rewrite'].includes(codexBrief.decision)) return false
  if (codexBrief.recommendation && codexBrief.recommendation !== 'Approve') return false
  if (codexBrief.risk && !/^låg\b/i.test(String(codexBrief.risk))) return false
  return true
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
  rememberPendingIntegrationRepair(report, channelId)
  await sendDiscordMessage(formatIntegrationDoctorMessage(report, true), channelId)
}

async function maybeAskForGscApiOAuth() {
  const today = new Date().toISOString().slice(0, 10)
  const doctor = await runGscDoctorThroughRuntime({ includeBrowser: true, deep: true }).catch((error) => ({ ok: false, api: { ok: false, status: 'runtime_doctor_failed', error: error?.message || String(error) }, browser: null }))
  const api = doctor.api || { ok: false, status: 'api_doctor_missing' }
  if (api.ok) return
  const browser = doctor.browser || { ok: false, status: 'browser_doctor_missing' }
  if (!browser.ok || !browser.canObserve) return
  await sendOncePerDay(`gsc-api-oauth-request:${today}`, channelId, formatGscApiOAuthRequest(api, browser))
}

function formatGscApiOAuthRequest(api, browser) {
  const lines = [
    'GSC behöver godkännas en gång för stabil API-access.',
    '',
    `Status: API saknas (${api.status || api.error || 'inte redo'}). Browser-fallback är redo.`,
    '',
    'Gör så här:',
    '1. Svara `gsc browser oauth` här.',
    `2. Öppna ${noVncUrl} och godkänn Google i Firefox.`,
    '3. Skriv `klart` här när Google-flödet är klart.',
  ]
  if (noVncAuthUser && noVncAuthPassword) {
    lines.splice(8, 0, `Browser-login: ${noVncAuthUser} / ${noVncAuthPassword}`)
  }
  if (noVncTunnelCommand) {
    lines.push('', `Om länken inte öppnas: \`${noVncTunnelCommand}\``)
  }
  return lines.join('\n').slice(0, 1900)
}

function formatNoVncAccessLines() {
  return [
    `Öppna VPS-Firefox/noVNC: ${noVncUrl}`,
    noVncAuthUser && noVncAuthPassword ? `Om browsern frågar efter login: använd ${noVncAuthUser} / ${noVncAuthPassword}` : '',
    noVncTunnelCommand ? `Om länken inte öppnas lokalt: kör \`${noVncTunnelCommand}\` och öppna länken igen.` : ''
  ].filter(Boolean)
}

async function buildIntegrationDoctorReport(workspaces) {
  const [gsc, gscRuntimeDoctor, googleAdsInitial, automation] = await Promise.allSettled([
    fetchPlatformJson('/api/platform/integrations/gsc/status'),
    runGscDoctorThroughRuntime({ includeBrowser: true, deep: true }),
    fetchPlatformJson('/api/platform/ad-automation/keyword-metrics', {
      method: 'POST',
      body: JSON.stringify({ keywords: ['ai agenter företag'] })
    }),
    localAutomationStatus(),
  ])
  const gscPayload = settledValue(gsc, null)
  const gscRuntimePayload = settledValue(gscRuntimeDoctor, null)
  const gscApiPayload = gscRuntimePayload?.api || null
  const gscBrowserPayload = gscRuntimePayload?.browser || null
  const gscPlatformConnected = Boolean(gscPayload?.connected ?? gscPayload?.hasStoredRefreshToken)
  const gscApiReady = Boolean(gscApiPayload?.ok)
  const gscBrowserReady = Boolean(gscBrowserPayload?.ok && gscBrowserPayload?.canObserve)
  const gscOperational = gscPlatformConnected || gscApiReady || gscBrowserReady
  const gscStatus = formatGscCapabilityStatus({
    platform: gscPayload ? String(gscPayload.connected ?? gscPayload.hasStoredRefreshToken ? 'connected' : gscPayload.status ?? 'not_connected') : settledErrorMessage(gsc),
    api: gscApiPayload ? String(gscApiPayload.status || (gscApiPayload.ok ? 'ready' : 'unknown')) : settledErrorMessage(gscRuntimeDoctor),
    browser: gscBrowserPayload ? String(gscBrowserPayload.status || (gscBrowserPayload.ok ? 'ready' : 'unknown')) : settledErrorMessage(gscRuntimeDoctor),
    gscPlatformConnected,
    gscApiReady,
    gscBrowserReady
  })
  const gscReconnectFix = gscOperational
    ? 'Ingen ny OAuth krävs för agentens URL Inspection just nu: agenten har en fungerande GSC-väg via API eller inloggad noVNC-Firefox. Koppla bara om GSC om färsk Search Console-data saknas i SEO Monitor-runs.'
    : await buildGscReconnectFix().catch((error) => `Jag kunde inte skapa OAuth-länk automatiskt: ${error?.message || String(error)}. Koppla om i Dashboard2 -> SEO Monitor -> Integrations.`)
  let googleAdsPayload = settledValue(googleAdsInitial, null)
  let googleAdsRepair = null
  if (googleAdsPayload?.status !== 'ready') {
    googleAdsRepair = await selfHealGoogleAdsKeywordPlanner()
    if (googleAdsRepair?.ok) {
      googleAdsPayload = googleAdsRepair.payload || googleAdsPayload
    }
  }
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
      label: 'Google Search Console URL Inspection',
      ok: gscOperational,
      status: gscStatus,
      fix: gscReconnectFix
    },
    {
      key: 'google_ads',
      label: 'Google Ads Keyword Planner OAuth',
      ok: Boolean(googleAdsPayload?.status === 'ready'),
      status: googleAdsPayload ? String(googleAdsPayload.status || googleAdsPayload.error || 'unknown') : settledErrorMessage(googleAdsInitial),
      fix: googleAdsRepair?.ok
        ? `Självreparerad via lokal OAuth-token (${googleAdsRepair.keywordPlannerStatus || 'ready'}).`
        : googleAdsRepair?.attempted
          ? `Agenten försökte självreparera men misslyckades: ${googleAdsRepair.error}. ${await googleAdsReconnectFix()}`
          : googleAdsPayload?.error
            ? `${await googleAdsReconnectFix()} Fel: ${googleAdsPayload.error}`
            : await googleAdsReconnectFix()
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
  const firstRepair = checks.find((check) => !check.ok && ['gsc', 'google_ads'].includes(check.key))
  const repairHint = firstRepair?.key === 'gsc'
    ? 'Jag har lagt OAuth-länken ovan. Du behöver bara öppna den och godkänna Google-access om tokenen faktiskt är trasig.'
    : firstRepair?.key === 'google_ads'
      ? 'Jag har lagt OAuth-länken ovan. Du behöver bara öppna den och godkänna Google Ads-access om tokenen faktiskt är trasig.'
      : 'Om något är rött och saknar länk kan du skriva `doctor` igen eller be mig felsöka integrationen.'
  return [
    onlyProblems ? 'Integration doctor: åtgärd krävs' : 'Integration doctor: aktuell status',
    `Tid: ${report.generatedAt}`,
    '',
    ...checks.map((check) => `${check.ok ? 'OK' : 'FIX'} ${check.label}: ${check.status}${check.ok ? '' : `\nFix: ${check.fix}`}`),
    '',
    repairHint
  ].join('\n').slice(0, 1900)
}

function formatGscCapabilityStatus({ platform, api, browser, gscPlatformConnected, gscApiReady, gscBrowserReady }) {
  if (gscPlatformConnected) return `platform_connected; api=${api}; browser=${browser}`
  if (gscApiReady) return `api_ready; platform=${platform}; browser=${browser}`
  if (gscBrowserReady) return `browser_fallback_ready; platform=${platform}; api=${api}`
  return `not_ready; platform=${platform}; api=${api}; browser=${browser}`
}

async function buildGscReconnectFix() {
  const runtimeStart = await startGscOauthThroughRuntime().catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (runtimeStart.ok) {
    return [
      'Öppna OAuth-länken och godkänn Search Console-access:',
      runtimeStart.authorizationUrl,
      'Efter callback/localhost-fel: klistra in hela callback-URL:en här eller skriv `klart` om den öppnades i noVNC-Firefox.'
    ].join('\n')
  }
  if (gscClientId() && gscClientSecret()) return `OAuth-länk kunde inte skapas via runtime: ${runtimeStart.error || runtimeStart.status || 'okänt fel'}`
  const payload = await fetchPlatformJson('/api/platform/integrations/gsc/start', {
    method: 'POST',
    body: JSON.stringify({ returnTo: 'https://dashboard2.sebcastwall.se/#/growth/seo-monitor' })
  })
  if (payload.authorizationUrl) {
    return [
      'Öppna OAuth-länken och godkänn Search Console-access:',
      payload.authorizationUrl,
      'När flödet är klart verifierar agenten status vid nästa doctor-körning.'
    ].join('\n')
  }
  return `OAuth-länk kunde inte skapas automatiskt: ${JSON.stringify(payload).slice(0, 300)}`
}

async function googleAdsReconnectFix() {
  const runtimeStart = await startGoogleAdsOauthThroughRuntime().catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (runtimeStart.ok) {
    return [
      'Öppna OAuth-länken och godkänn Google Ads-access:',
      runtimeStart.authorizationUrl,
      'Efter callback/localhost-fel: klistra in hela callback-URL:en här eller skriv `klart` om den öppnades i noVNC-Firefox.'
    ].join('\n')
  }
  if (env.GOOGLE_ADS_CLIENT_ID && env.GOOGLE_ADS_CLIENT_SECRET) return `Google Ads OAuth-länk kunde inte skapas via runtime: ${runtimeStart.error || runtimeStart.status || 'okänt fel'}`
  return 'Google Ads OAuth-länk kan inte skapas automatiskt eftersom GOOGLE_ADS_CLIENT_ID/SECRET saknas i agentens env.'
}

function rememberPendingIntegrationRepair(report, targetChannelId) {
  const problems = (report?.checks || []).filter((check) => !check.ok)
  const integration = problems.find((check) => check.key === 'gsc')
    || problems.find((check) => check.key === 'google_ads')
  if (!integration) return
  state.pendingIntegrationRepair = state.pendingIntegrationRepair || {}
  state.pendingIntegrationRepair[targetChannelId] = {
    type: integration.key,
    label: integration.label,
    status: integration.status,
    at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  }
  saveState()
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
  const runtimeRun = await runNextApprovedCodeActionThroughRuntime()
  if (runtimeRun?.running) return true
  if (runtimeRun?.ran) {
    reloadStateFromDisk()
    await postRuntimeCodeActionResult(runtimeRun)
    return true
  }
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
      && !codeActionResultBlocks(action, workspace, targetChannelId)
      && isCodeAction(action)
    )
    if (!approved) continue
    delete state.codeActionResults[approved.id]
    state.codeActionRunning = { actionId: approved.id, startedAt: new Date().toISOString() }
    recordActionLedger(approved, workspace, targetChannelId, 'coding_started', { source: 'platform_approved' })
    saveState()
    try {
      const result = await runCodexAction({ ...approved, repoFullName: workspace.repoFullName, branch: workspace.branch || 'main' })
      const completedResult = { ...result, repoFullName: workspace.repoFullName, branch: workspace.branch || 'main' }
      state.codeActionResults[approved.id] = { status: 'completed', completedAt: new Date().toISOString(), result: completedResult }
      recordActionLedger(approved, workspace, targetChannelId, 'completed', { commit: result.commit || null, diffStat: result.diffStat || null, repoFullName: workspace.repoFullName })
      recordSeoExperiment(approved, workspace, targetChannelId, completedResult, { source: 'platform_approved' })
      clearActiveAction(approved.id)
      const commitUrl = result.commit ? githubCommitUrl(workspace.repoFullName, result.commit) : ''
      const posted = await sendDiscordMessage([
        `Kodaction klar för ${workspace.label}: ${approved.title}`,
        `Action ID: \`${approved.id}\``,
        result.commit ? `Commit: ${result.commit}` : '',
        commitUrl ? `GitHub: ${commitUrl}` : '',
        result.diffStat ? `Diff:\n\`\`\`\n${String(result.diffStat).slice(0, 1200)}\n\`\`\`` : '',
        '',
        'Om detta blev fel kan du trycka Backa så skapar jag en revert-commit.'
      ].filter(Boolean).join('\n'), targetChannelId, rollbackComponents(), { kind: 'code_result' })
      state.messageToAction = state.messageToAction || {}
      state.messageToAction[posted.id] = approved.id
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
  const entries = Object.values(queue)
    .filter((item) => item?.id)
    .sort((a, b) => Date.parse(b.queuedAt || 0) - Date.parse(a.queuedAt || 0))
  for (const entry of entries) {
    const workspace = workspaces.find((item) => item.repoFullName === entry.repoFullName)
      || workspaces.find((item) => item.label === entry.workspaceSlug)
      || { label: entry.workspaceSlug || entry.repoFullName || 'workspace', repoFullName: entry.repoFullName, branch: entry.branch || 'main' }
    const targetChannelId = entry.channelId || await channelForWorkspace(workspace)
    if (codeActionResultBlocks(entry, workspace, targetChannelId)) {
      delete state.approvedCodeActionQueue[entry.id]
      log('approved_queue_item_blocked_by_existing_result', { actionId: entry.id, workspace: workspace?.label || workspace?.repoFullName || null })
      saveState()
      continue
    }
    delete state.codeActionResults[entry.id]
    return await runQueuedApprovedCodeAction(entry, workspace, targetChannelId)
  }
  return false
}

async function runQueuedApprovedCodeAction(entry, workspace, targetChannelId) {
  if (!entry) return false
  state.codeActionRunning = { actionId: entry.id, startedAt: new Date().toISOString(), source: 'approved_queue' }
  recordActionLedger(entry, workspace, targetChannelId, 'coding_started', { source: 'approved_queue' })
  saveState()
  try {
    const result = await runCodexAction({ ...entry, repoFullName: entry.repoFullName || workspace.repoFullName, branch: entry.branch || workspace.branch || 'main' })
    const completedResult = { ...result, repoFullName: entry.repoFullName || workspace.repoFullName || null, branch: entry.branch || workspace.branch || 'main' }
    state.codeActionResults[entry.id] = { status: 'completed', completedAt: new Date().toISOString(), result: completedResult }
    recordActionLedger(entry, workspace, targetChannelId, 'completed', {
      commit: result.commit || null,
      diffStat: result.diffStat || null,
      repoFullName: entry.repoFullName || workspace.repoFullName || null
    })
    recordSeoExperiment(entry, workspace, targetChannelId, completedResult, { source: 'approved_queue' })
    delete state.approvedCodeActionQueue[entry.id]
    await markPostedActionHandled(entry.id, targetChannelId, 'code_action_completed')
    clearActiveAction(entry.id)
    const commitUrl = result.commit ? githubCommitUrl(entry.repoFullName || workspace.repoFullName, result.commit) : ''
    const posted = await sendDiscordMessage([
      `Kodaction klar för ${workspace.label || entry.workspaceSlug}: ${entry.title}`,
      `Action ID: \`${entry.id}\``,
      result.commit ? `Commit: ${result.commit}` : '',
      commitUrl ? `GitHub: ${commitUrl}` : '',
      result.diffStat ? `Diff:\n\`\`\`\n${String(result.diffStat).slice(0, 1200)}\n\`\`\`` : '',
      '',
      'Om detta blev fel kan du trycka Backa så skapar jag en revert-commit.'
    ].filter(Boolean).join('\n'), targetChannelId, rollbackComponents(), { kind: 'code_result' })
    state.messageToAction = state.messageToAction || {}
    state.messageToAction[posted.id] = entry.id
  } catch (error) {
    const failure = classifyCodeActionFailure(error)
    state.codeActionResults[entry.id] = { status: failure.status, failedAt: new Date().toISOString(), error: error?.message || String(error), failure }
    recordActionLedger(entry, workspace, targetChannelId, failure.ledgerEvent, { error: error?.message || String(error), failure })
    if (failure.status === 'no_changes') {
      rememberAgentLesson(`No-op action for ${workspace?.label || entry.workspaceSlug || entry.repoFullName}: ${entry.title || entry.id}. Future scouts must inspect the target file and avoid recommending content already present.`)
      if (state.codexOpportunityScout) delete state.codexOpportunityScout[workspaceProfileKey(workspace, targetChannelId)]
    }
    delete state.approvedCodeActionQueue[entry.id]
    await markPostedActionHandled(entry.id, targetChannelId, 'code_action_failed')
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

async function revertCompletedCodeAction(actionId, targetChannelId) {
  const resultRecord = state.codeActionResults?.[actionId]
  const result = resultRecord?.result || {}
  const commit = String(result.commit || '').trim()
  const repoFullName = String(result.repoFullName || '').trim()
  const branch = String(result.branch || 'main').trim() || 'main'
  if (!resultRecord || resultRecord.status !== 'completed') {
    return { summary: `Jag hittar ingen färdig kodaction att backa för ${actionId}.` }
  }
  if (resultRecord.revertedAt || resultRecord.revertCommit) {
    return { summary: `Den här actionen är redan backad: ${resultRecord.revertCommit || resultRecord.revertedAt}.` }
  }
  if (!commit || !repoFullName) {
    return { summary: 'Jag saknar commit eller repo för den här actionen, så jag kan inte backa säkert.' }
  }
  const workspace = workspaceForChannel(targetChannelId) || { label: repoFullName, repoFullName, branch }
  state.codeActionRunning = { actionId, startedAt: new Date().toISOString(), source: 'revert_button' }
  saveState()
  try {
    const revert = await runGitRevert({ repoFullName, branch, commit, actionId })
    state.codeActionResults[actionId] = {
      ...resultRecord,
      status: 'reverted',
      revertedAt: new Date().toISOString(),
      revertCommit: revert.revertCommit,
      revertDiffStat: revert.diffStat
    }
    recordActionLedger({ id: actionId, title: `Backa ${commit}` }, workspace, targetChannelId, 'reverted', {
      commit,
      revertCommit: revert.revertCommit,
      repoFullName
    })
    saveState()
    const url = githubCommitUrl(repoFullName, revert.revertCommit)
    return {
      summary: `Backning klar. Revert-commit: ${revert.revertCommit}`,
      publicMessage: [
        `Backade SEO-agentens ändring för ${workspace.label || repoFullName}.`,
        `Original commit: ${commit}`,
        `Revert commit: ${revert.revertCommit}`,
        url ? `GitHub: ${url}` : '',
        revert.diffStat ? `Diff:\n\`\`\`\n${String(revert.diffStat).slice(0, 1000)}\n\`\`\`` : ''
      ].filter(Boolean).join('\n')
    }
  } catch (error) {
    log('revert_code_action_failed', { actionId, repoFullName, commit, error: error?.message || String(error) })
    return { summary: `Backning misslyckades: ${String(error?.message || error).slice(0, 1500)}` }
  } finally {
    state.codeActionRunning = null
    saveState()
  }
}

async function runGitRevert({ repoFullName, branch, commit, actionId }) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const repoName = String(repoFullName || '').split('/')[1]
  if (!repoName) throw new Error(`Invalid repoFullName: ${repoFullName}`)
  const repoDir = `/home/deploy/seo-agent-workspaces/${repoName}`
  const runnerEnv = { ...process.env, PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}` }
  const run = (cmd, args, cwd = repoDir) => exec(cmd, args, { cwd, env: runnerEnv, timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 })
  if (!existsSync(join(repoDir, '.git'))) throw new Error(`Repo checkout missing: ${repoDir}`)
  const status = await run('git', ['status', '--porcelain'])
  if (status.stdout.trim()) throw new Error(`Repo is not clean: ${repoDir}`)
  await run('git', ['checkout', branch])
  await run('git', ['fetch', 'origin', branch])
  await run('git', ['merge', '--ff-only', 'FETCH_HEAD'])
  await run('git', ['config', 'user.name', 'SEO Agent'])
  await run('git', ['config', 'user.email', 'seo-agent@sebcastwall.se'])
  await run('git', ['revert', '--no-edit', commit])
  await runBestBuildForRepo(repoDir, run)
  const diff = await run('git', ['show', '--stat', '--oneline', 'HEAD'])
  await run('git', ['add', '-A'])
  await run('git', ['commit', '--amend', '-m', `Revert SEO action ${actionId}\n\nReverts SEO agent commit: ${commit}`])
  const revertCommit = await run('git', ['rev-parse', '--short', 'HEAD'])
  await run('git', ['push', 'origin', `HEAD:${branch}`])
  return { revertCommit: revertCommit.stdout.trim(), diffStat: diff.stdout }
}

async function runBestBuildForRepo(repoDir, run) {
  const cwd = existsSync(join(repoDir, 'package.json')) ? repoDir
    : existsSync(join(repoDir, 'web', 'package.json')) ? join(repoDir, 'web')
    : null
  if (!cwd) return
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  const scripts = pkg.scripts || {}
  if (scripts.typecheck) await runPackageScriptForRepo(cwd, 'typecheck', run)
  if (scripts.build) await runPackageScriptForRepo(cwd, 'build', run)
}

async function runPackageScriptForRepo(cwd, script, run) {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return run('pnpm', ['run', script], cwd)
  if (existsSync(join(cwd, 'yarn.lock'))) return run('yarn', [script], cwd)
  return run('npm', ['run', script], cwd)
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
      exec('bash', ['-lc', 'missing=\"\"; failed=\"\"; for repo in sebcastwall natverkskollen parkeringspolaren-web vagkollen; do dir=\"$HOME/seo-agent-workspaces/$repo\"; if [ ! -d \"$dir/.git\" ]; then missing=\"$missing ${repo}\"; continue; fi; if [ -n \"$(git -C \"$dir\" status --porcelain)\" ]; then failed=\"$failed ${repo}:dirty\"; continue; fi; git -C \"$dir\" fetch origin main >/dev/null 2>&1 && git -C \"$dir\" merge --ff-only FETCH_HEAD >/dev/null 2>&1 && git -C \"$dir\" push --dry-run origin HEAD:main >/dev/null 2>&1 || failed=\"$failed ${repo}\"; done; if [ -n \"$failed\" ]; then echo \"missing:${failed# }\"; else echo ready; fi']),
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
  const runtimeCurrent = await fetchCurrentSeoActionThroughRuntime(workspace, targetChannelId, 10)
  const actions = runtimeCurrent.ok
    ? {
        actions: runtimeCurrent.payload.actions || [],
        workspacePolicy: runtimeCurrent.payload.workspacePolicy || '',
        workspace: runtimeCurrent.payload.workspace || null,
        runtimeSource: 'seo-runtime-current'
      }
    : await fetchSeoMonitorActions(workspace, 10)
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
  let orderedPending = prioritizeActionQueue(pending, workspace, targetChannelId)
  if (runtimeCurrent.ok) {
    const selectedId = String(runtimeCurrent.payload?.selectedActionId || '')
    if (!selectedId) {
      logThrottled(`runtime_no_postable_candidate:${activeKey}`, 30 * 60 * 1000, 'runtime_no_postable_candidate', {
        workspace: workspace?.label || workspace?.id || null,
        candidateCount: runtimeCurrent.payload?.candidateCount ?? pending.length,
        rejected: runtimeCurrent.payload?.rejected?.slice?.(0, 6) || []
      })
      return
    }
    const selected = pending.find((item) => String(item?.id || '') === selectedId)
    if (selected) orderedPending = [selected]
  } else {
    const runtimeSelection = await selectNextActionThroughRuntime({
      workspace,
      targetChannelId,
      actions: pending,
      workspacePolicy: actions.workspacePolicy
    })
    if (runtimeSelection.ok) {
      const selectedId = String(runtimeSelection.payload?.selectedActionId || '')
      if (!selectedId) {
        logThrottled(`runtime_no_postable_candidate:${activeKey}`, 30 * 60 * 1000, 'runtime_no_postable_candidate', {
          workspace: workspace?.label || workspace?.id || null,
          candidateCount: runtimeSelection.payload?.candidateCount ?? pending.length,
          rejected: runtimeSelection.payload?.rejected?.slice?.(0, 6) || []
        })
        return
      }
      const selected = pending.find((item) => String(item?.id || '') === selectedId)
      if (selected) orderedPending = [selected]
    }
  }
  for (const action of orderedPending) {
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
      if (guard.reason === 'repeatedly_guarded') {
        logThrottled(`action_card_repeatedly_guarded:${actionLearningKey(enrichedAction, workspace, targetChannelId)}`, 6 * 60 * 60 * 1000, 'action_card_repeatedly_guarded', { id, workspace: workspace?.label || workspace?.id || null })
        continue
      }
      rememberGuardedAction(enrichedAction, workspace, targetChannelId, guard.reason)
      logThrottled(`action_card_guarded:${id}:${guard.reason}`, 6 * 60 * 60 * 1000, 'action_card_guarded', { id, workspace: workspace?.label || workspace?.id || null, reason: guard.reason })
      continue
    }
    const review = reviewActionForPosting(enrichedAction, workspace, targetChannelId, actions.workspacePolicy)
    if (!review.ok) {
      rememberGuardedAction(enrichedAction, workspace, targetChannelId, review.reason)
      log('action_card_review_rejected', { id, workspace: workspace?.label || workspace?.id || null, reason: review.reason, score: review.score })
      continue
    }
    if (shouldSuppressDecisionCard(enrichedAction, review, workspace, targetChannelId)) {
      rememberGuardedAction(enrichedAction, workspace, targetChannelId, 'autonomous_or_internal_not_decision_card')
      logThrottled(`action_card_suppressed:${id}`, 6 * 60 * 60 * 1000, 'action_card_suppressed', { id, workspace: workspace?.label || workspace?.id || null, reason: 'autonomous_or_internal_not_decision_card', recommendation: review.recommendation })
      continue
    }
    const message = await buildActionCardMessage(enrichedAction, actions.workspacePolicy, workspace, review, targetChannelId)
    if (!message) {
      recordActionLedger(enrichedAction, workspace, targetChannelId, 'guarded', { systemKey, guard: 'codex_action_card_blocked', review })
      continue
    }
    const posted = await sendDiscordMessage(message, targetChannelId, actionComponents(enrichedAction))
    const runtimePosted = await markActionPostedThroughRuntime({
      action: enrichedAction,
      workspace,
      targetChannelId,
      messageId: posted.id,
      activeKey,
      systemKey,
      guard: guard.reason || 'passed',
      review
    })
    if (!runtimePosted.ok) {
      recordActionLedger(enrichedAction, workspace, targetChannelId, 'posted', { messageId: posted.id, systemKey, guard: guard.reason || 'passed', review })
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
    }
    if (isIndexingCheckAction(enrichedAction) && !isGscAuthAction(enrichedAction)) {
      await autoRunGscInspectionForPostedAction(enrichedAction, workspace, targetChannelId).catch((error) => {
        log('auto_gsc_inspection_failed', { actionId: id, workspace: workspace?.label || workspace?.id || null, error: error?.message || String(error) })
      })
    }
    
    break
  }
}

async function autoRunGscInspectionForPostedAction(action, workspace, targetChannelId) {
  if (!action?.targetUrl) return
  const actionId = String(action.id || '')
  if (!actionId) return
  state.autoGscInspectionAttempts = state.autoGscInspectionAttempts || {}
  const key = `${actionId}:${new Date().toISOString().slice(0, 10)}`
  if (state.autoGscInspectionAttempts[key]) return
  state.autoGscInspectionAttempts[key] = { startedAt: new Date().toISOString(), targetUrl: action.targetUrl }
  saveState()
  const result = await runGscInspectionAction(action, workspace, targetChannelId, 'auto_gsc_ui')
  state.autoGscInspectionAttempts[key] = {
    ...state.autoGscInspectionAttempts[key],
    completedAt: new Date().toISOString(),
    ok: Boolean(result?.ok),
    indexed: Boolean(result?.indexedByGsc),
    error: result?.error || null,
    observationPath: result?.observationPath || null
  }
  saveState()
}

async function maybeRemindActiveAction({ workspace, targetChannelId, activeKey, active, actions }) {
  if (!activeActionReminderMs || activeActionReminderMs < 60 * 1000) return
  const postedAtMs = Date.parse(active.remindedAt || active.repostedAt || active.postedAt || '')
  if (!postedAtMs || Date.now() - postedAtMs < activeActionReminderMs) return
  const lastReminderKey = active.lastReminderAt ? Date.parse(active.lastReminderAt) : 0
  if (lastReminderKey && Date.now() - lastReminderKey < activeActionReminderMs) return
  const posted = await repostActiveActionCard(workspace, actions, targetChannelId, {
    intro: 'Påminnelse: det här SEO-kortet ligger fortfarande i kandidatkö.'
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

function shouldSuppressDecisionCard(action, review, workspace, targetChannelId) {
  if (isGscAuthAction(action) || isIndexingCheckAction(action)) return true
  if (isKeywordPlanAction(action)) return true
  const kind = review?.kind || actionKindForLearning(action)
  if (kind === 'new-page') return false
  if (!isCodeAction(action)) return true
  if (!automationEnabled || !autonomousCodeEnabled || !codeAutomationEnabled) return false
  if (['Approve', 'Review'].includes(String(review?.recommendation || ''))) return true
  const check = autonomousCodeCandidateCheck(action, workspace, targetChannelId)
  return check.ok || ['already_completed_waiting_recheck', 'recently_deprioritized_waiting_recheck', 'recently_ignored_waiting_recheck'].includes(check.reason)
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

async function markPostedActionHandled(actionId, targetChannelId = null, reason = 'handled') {
  const id = String(actionId || '')
  if (!id) return
  const posted = state.postedActionIds?.[id]
  if (!posted?.messageId) return
  const channel = posted.channelId || targetChannelId
  if (!channel) return
  state.postedActionIds[id] = {
    ...posted,
    handledAt: new Date().toISOString(),
    handledReason: reason
  }
  try {
    await discordJson(`/channels/${channel}/messages/${posted.messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ components: [] })
    })
  } catch (error) {
    logThrottled(`mark_posted_action_handled_failed:${id}`, 60 * 60 * 1000, 'mark_posted_action_handled_failed', {
      actionId: id,
      channelId: channel,
      messageId: posted.messageId,
      error: error?.message || String(error)
    })
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
    await handleChatMessage(String(message.content || ''), message, targetChannelId)
  }
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
      if (!customId.startsWith('seo-decision:') && !customId.startsWith('seo-gsc-ui:') && !customId.startsWith('seo-revert:')) return
      if (String(interaction.user?.id || '') !== allowedUserId) {
        await interaction.reply({ content: 'Ignored: this Discord user is not allowed to control the SEO agent.', ephemeral: true })
        return
      }

      const actionId = state.messageToAction?.[interaction.message?.id] || extractActionIdFromDiscordMessage(interaction.message)
      if (!actionId) {
        await interaction.reply({ content: 'Jag hittar inte action-id för den här knappen. Be mig posta om det aktiva kortet, så skickar jag en ny knapp.', ephemeral: true })
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
      if (customId.startsWith('seo-revert:')) {
        await interaction.deferReply({ ephemeral: true })
        const result = await revertCompletedCodeAction(actionId, interaction.channelId)
        await interaction.editReply({ content: result.summary })
        if (result.publicMessage) await sendDiscordMessage(result.publicMessage, interaction.channelId)
        await interaction.message.edit({ components: [] }).catch(() => null)
        return
      }

      const decision = customId.slice('seo-decision:'.length)
      const decisionInput = {
        actionId,
        decision,
        reason: null,
        source: 'discord_button',
        discordMessageId: interaction.message.id,
        discordChannelId: interaction.channelId,
      }
      saveState()
      const runtimeResult = await executeActionDecisionThroughRuntime(decisionInput)
      const result = runtimeResult.ok
        ? await saveActionDecisionBestEffort(decisionInput)
        : await saveActionDecision(decisionInput)
      if (!runtimeResult.ok) {
        recordDecisionInLedger(actionId, decision, interaction.channelId, { source: 'discord_button' })
        if (decision === 'approved') {
          await rememberApprovedCodeAction(actionId, interaction.channelId)
          clearActiveAction(actionId)
        } else clearActiveAction(actionId)
      }
      await interaction.reply({ content: decision === 'approved' ? `Approve sparad för ${result?.decision?.actionId || actionId}. Jag startar kodautomation på nästa agent-tick och postar commit/diff här.` : `Sparat beslut: ${decision} för ${result?.decision?.actionId || actionId}.`, ephemeral: true })
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
  const result = await runGscInspectionAction(action, workspace, targetChannelId, 'discord_gsc_ui')
  return result.ok
    ? result.indexedByGsc
      ? 'Jag körde GSC URL Inspection, verifierade indexering och markerade kortet som hanterat.'
      : 'Jag körde GSC URL Inspection i noVNC-Firefoxen och postade observationen i kanalen.'
    : `Kunde inte öppna GSC UI: ${result.error || result.status || 'okänt fel'}`
}

async function runGscInspectionAction(action, workspace, targetChannelId, source = 'gsc_firefox_ui') {
  const targetUrl = action.targetUrl || ''
  const host = targetUrl ? new URL(targetUrl).hostname.replace(/^www\./, '') : String(workspace?.gscProperty || '').replace(/^sc-domain:/, '')
  const input = {
    command: 'inspect-url',
    workspaceId: workspace?.id || null,
    workspaceHost: host,
    gscProperty: workspace?.gscProperty || '',
    targetUrl
  }
  const result = await runGscInspectionThroughRuntime(input).catch((error) => {
    logThrottled('runtime_gsc_inspection_failed', 15 * 60 * 1000, 'runtime_gsc_inspection_failed', {
      targetUrl,
      error: error?.message || String(error)
    })
    return { ok: false, status: 'runtime_unavailable', error: error?.message || String(error) }
  })
  const observationPath = result?.observation?.path || ''
  const indexedByGsc = result?.inspection?.status === 'indexed' && Number(result?.inspection?.confidence || 0) >= 0.8
  if (indexedByGsc) {
    const decisionInput = {
      actionId: action.id,
      decision: 'skipped',
      reason: `GSC URL Inspection verified indexed (${result.inspection.reason}, confidence ${Number(result.inspection.confidence).toFixed(2)}).`,
      source: `${source}_indexed`,
      discordMessageId: null,
      discordChannelId: targetChannelId
    }
    saveState()
    const runtimeResult = await executeActionDecisionThroughRuntime(decisionInput)
    if (runtimeResult.ok) {
      await saveActionDecisionBestEffort(decisionInput)
    } else {
      await saveActionDecision(decisionInput).catch((error) => log('gsc_indexed_decision_failed', { actionId: action.id, error: error?.message || String(error) }))
      clearActiveAction(action.id)
    }
    state.indexingConfirmations = state.indexingConfirmations || {}
    state.indexingConfirmations[`${workspace?.label || workspace?.id || 'workspace'}:${normalizeActionPath(action.targetUrl || '')}`] = {
      status: 'indexed',
      actionId: action.id,
      confirmedAt: new Date().toISOString(),
      source,
      observationPath,
      inspection: result.inspection
    }
    saveState()
  }
  await sendDiscordMessage([
    `${source === 'auto_gsc_ui' ? 'Jag försökte själv köra' : 'GSC URL Inspection körd för'} ${workspace?.label || workspace?.id || 'workspace'}.`,
    targetUrl ? `URL att inspektera: ${targetUrl}` : '',
    result.source === 'google_url_inspection_api' ? 'Källa: Google URL Inspection API.' : '',
    result.apiFallbackReason ? `API-fallback: ${result.apiFallbackReason}.` : '',
    indexedByGsc ? `Resultat: GSC visar att URL:en är indexerad (${Number(result.inspection.confidence).toFixed(2)} confidence). Jag markerade kortet som hanterat.` : '',
    result.ok && observationPath ? `Observation sparad på VPS: ${observationPath}` : '',
    result.ok && !indexedByGsc ? formatGscInspectionFollowup(result) : '',
    !result.ok ? `Fel: ${result.error || result.status || 'kunde inte öppna GSC UI'}` : ''
  ].filter(Boolean).join('\n'), targetChannelId)
  return {
    ok: Boolean(result.ok),
    indexedByGsc,
    error: result.error || result.status || '',
    observationPath
  }
}

async function runGscInspectionThroughRuntime(input) {
  const response = await fetch(`${seoRuntimeUrl}/seo/integrations/gsc/url-inspection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok || !payload || payload.ok === false && !payload.result) {
    throw new Error(payload?.error || payload?.detail || text || `runtime_gsc_inspection_http_${response.status}`)
  }
  return payload.result || payload
}

function formatGscInspectionFollowup(result) {
  const status = result?.inspection?.status || 'unknown'
  const reason = result?.inspection?.reason || ''
  const attempts = Array.isArray(result?.attempts) ? result.attempts : []
  if (status === 'not_indexed_or_warning') {
    return 'Resultat: GSC visar en indexeringsvarning. Jag lämnar kortet öppet så agenten kan föreslå repo-fix eller markera som hanterat efter kontroll.'
  }
  if (/url_not_in_property/i.test(reason)) {
    return 'Fel: GSC säger att URL:en inte ligger i vald property. Jag behandlar det som workspace/property-matchningsfel, inte som content-fix.'
  }
  const attemptedStrategies = attempts.map((attempt) => attempt.strategy).filter(Boolean).join(', ')
  return [
    'Fel: jag kunde öppna GSC, men URL Inspection gav inget säkert resultat.',
    attemptedStrategies ? `Försökta UI-strategier: ${attemptedStrategies}.` : '',
    'Det här är ett browser-/UI-automationsfel tills motsatsen är bevisad, inte ett krav på att koppla om GSC OAuth.'
  ].filter(Boolean).join('\n')
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

function reloadStateFromDisk() {
  const fresh = loadState()
  for (const key of Object.keys(state)) delete state[key]
  Object.assign(state, fresh)
  ensureAutonomousAgentState()
}

async function executeActionDecisionThroughRuntime({
  actionId,
  decision,
  reason,
  source,
  discordMessageId,
  discordChannelId,
  operatorId = allowedUserId
}) {
  const idempotencyKey = [
    'discord',
    source || 'decision',
    discordMessageId || discordChannelId || 'no-message',
    actionId,
    decision
  ].join(':')
  try {
    const response = await fetch(`${seoRuntimeUrl}/seo/actions/${encodeURIComponent(actionId)}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision,
        operatorId: operatorId ? `discord:${operatorId}` : 'discord:unknown',
        reason: reason || source || 'discord_decision',
        idempotencyKey
      })
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text }
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.detail || text || `runtime_http_${response.status}`)
    }
    reloadStateFromDisk()
    log('runtime_decision_saved', { actionId, decision, source, idempotencyKey })
    return { ok: true, payload }
  } catch (error) {
    log('runtime_decision_failed_fallback_to_worker', {
      actionId,
      decision,
      source,
      error: error?.message || String(error)
    })
    return { ok: false, error: error?.message || String(error) }
  }
}

async function selectNextActionThroughRuntime({ workspace, targetChannelId, actions, workspacePolicy }) {
  const workspaceKey = encodeURIComponent(workspaceProfileKey(workspace, targetChannelId))
  try {
    const response = await fetch(`${seoRuntimeUrl}/seo/workspaces/${workspaceKey}/actions/next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace,
        targetChannelId,
        workspacePolicy: workspacePolicy || '',
        actions: Array.isArray(actions) ? actions : []
      })
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text }
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.detail || text || `runtime_http_${response.status}`)
    }
    log('runtime_next_action_selected', {
      workspace: workspace?.label || workspace?.id || workspace?.repoFullName || null,
      selectedActionId: payload?.selectedActionId || null,
      acceptedCount: payload?.acceptedCount ?? null,
      candidateCount: payload?.candidateCount ?? null
    })
    return { ok: true, payload }
  } catch (error) {
    log('runtime_next_action_failed_fallback_to_worker', {
      workspace: workspace?.label || workspace?.id || workspace?.repoFullName || null,
      error: error?.message || String(error)
    })
    return { ok: false, error: error?.message || String(error) }
  }
}

async function fetchCurrentSeoActionThroughRuntime(workspace, targetChannelId, limit = 10) {
  const workspaceKey = encodeURIComponent(workspaceProfileKey(workspace, targetChannelId))
  const cacheTtlMs = Number(env.SEO_RUNTIME_CURRENT_ACTION_CACHE_MS || String(60 * 1000))
  const cacheKey = `current:${workspaceKey}:${limit}`
  const cached = runtimeLiveActionsCache.get(cacheKey)
  if (cached && Date.now() - cached.at < cacheTtlMs) return { ok: true, payload: JSON.parse(JSON.stringify(cached.payload)) }
  try {
    const response = await fetch(`${seoRuntimeUrl}/seo/workspaces/${workspaceKey}/actions/current`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace,
        targetChannelId,
        limit,
        includeGscProperty: true
      })
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text }
    }
    if (!response.ok || payload?.ok === false || !Array.isArray(payload?.actions)) {
      throw new Error(payload?.error || payload?.detail || text || `runtime_current_http_${response.status}`)
    }
    log('runtime_current_action_selected', {
      workspace: workspace?.label || workspace?.id || workspace?.repoFullName || null,
      selectedActionId: payload?.selectedActionId || null,
      acceptedCount: payload?.acceptedCount ?? null,
      candidateCount: payload?.candidateCount ?? null,
      actionCount: payload.actions.length
    })
    runtimeLiveActionsCache.set(cacheKey, { at: Date.now(), payload })
    return { ok: true, payload: JSON.parse(JSON.stringify(payload)) }
  } catch (error) {
    logThrottled(`runtime_current_action_failed:${workspace?.id || workspace?.repoFullName || workspace?.label || 'default'}`, 15 * 60 * 1000, 'runtime_current_action_failed', {
      workspace: workspace?.label || workspace?.id || workspace?.repoFullName || null,
      error: error?.message || String(error)
    })
    return { ok: false, error: error?.message || String(error) }
  }
}

async function fetchRuntimeTickAdvice() {
  try {
    const response = await fetch(`${seoRuntimeUrl}/seo/tick/advice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        now: new Date().toISOString(),
        dailyHourUtc,
        intervals: {
          runCheckMs: runCheckEveryMs,
          integrationDoctorMs: integrationDoctorEveryMs,
          gscIssueCheckMs: gscIssueCheckEveryMs,
          repoCommitSyncMs: repoCommitSyncEveryMs,
          opportunityScoutMinMs: opportunityScoutMinIntervalMs
        }
      })
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text }
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.detail || text || `runtime_tick_advice_http_${response.status}`)
    }
    state.runtimeTickAdvice = {
      ...(state.runtimeTickAdvice || {}),
      lastAdviceAt: payload.generatedAt || new Date().toISOString(),
      today: payload.today || new Date().toISOString().slice(0, 10)
    }
    return payload
  } catch (error) {
    logThrottled('runtime_tick_advice_failed', 15 * 60 * 1000, 'runtime_tick_advice_failed', {
      error: error?.message || String(error)
    })
    return {
      ok: false,
      fallback: true,
      steps: {
        processDiscordReplies: true,
        syncWorkspaceRepoCommits: true,
        ensureDailyRunsForWorkspaces: true,
        runDailyRankingReviews: true,
        postReadinessForWorkspaces: true,
        checkGscIssuesForWorkspaces: true,
        postPendingActionsForWorkspaces: true,
        prepareAutonomousCodeWork: true,
        runIntegrationDoctor: true,
        askForGscApiOauth: true
      }
    }
  }
}

async function markActionPostedThroughRuntime({ action, workspace, targetChannelId, messageId, activeKey, systemKey, guard, review }) {
  const actionId = String(action?.id || '')
  if (!actionId || !messageId || !targetChannelId) return { ok: false, error: 'missing_action_posted_payload' }
  try {
    const response = await fetch(`${seoRuntimeUrl}/seo/actions/${encodeURIComponent(actionId)}/posted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        workspace,
        channelId: targetChannelId,
        messageId,
        activeKey,
        systemKey,
        guard,
        review,
        idempotencyKey: `discord:${messageId}:posted`
      })
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text }
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.detail || text || `runtime_posted_http_${response.status}`)
    }
    reloadStateFromDisk()
    log('runtime_action_posted', {
      actionId,
      messageId,
      channelId: targetChannelId,
      activeKey
    })
    return { ok: true, payload }
  } catch (error) {
    logThrottled(`runtime_action_posted_failed:${actionId}`, 15 * 60 * 1000, 'runtime_action_posted_failed', {
      actionId,
      messageId,
      channelId: targetChannelId,
      error: error?.message || String(error)
    })
    return { ok: false, error: error?.message || String(error) }
  }
}

async function saveActionDecisionBestEffort(input) {
  try {
    return await saveActionDecision(input)
  } catch (error) {
    log('platform_decision_save_failed_non_blocking', {
      actionId: input?.actionId || null,
      decision: input?.decision || null,
      error: error?.message || String(error)
    })
    return null
  }
}

async function handleChatMessage(content, message, targetChannelId) {
  const trimmed = content.trim()
  if (!trimmed || trimmed.length < 2) return
  if (/^(google ads browser oauth|ads browser oauth|keyword planner browser oauth)$/i.test(trimmed)) {
    await sendDiscordMessage(await openGoogleAdsOauthInFirefox(), targetChannelId)
    return
  }
  if (/^(google ads read browser|ads read browser|keyword planner read browser|read ads browser)$/i.test(trimmed)) {
    await readGoogleAdsOauthFromFirefox(message, targetChannelId)
    return
  }
  if (/^(gsc browser oauth|search console browser oauth|gsc oauth browser)$/i.test(trimmed)) {
    await sendDiscordMessage(await openGscOauthInFirefox(), targetChannelId)
    return
  }
  if (/^(gsc read browser|search console read browser|read gsc browser)$/i.test(trimmed)) {
    await readGscOauthFromFirefox(message, targetChannelId)
    return
  }
  if (/^(klart|done|färdig|fardig)$/i.test(trimmed)) {
    if (await readPendingOauthFromFirefox(message, targetChannelId)) return
  }
  if (/^(koppla|koppla om|connect|reconnect|fixa|laga)$/i.test(trimmed)) {
    if (await handlePendingIntegrationRepair(targetChannelId)) return
  }
  if (/koppla.*(gsc|search console)|(?:gsc|search console).*koppla|search console.*oauth|gsc.*oauth|gsc.*login|search console.*login/i.test(trimmed)) {
    await sendDiscordMessage(await formatGscOauthStartMessage(), targetChannelId)
    return
  }
  if (/koppla.*(google ads|ads|keyword planner)|(?:google ads|ads|keyword planner).*koppla|google ads.*oauth|ads oauth|keyword planner.*oauth|google ads.*login/i.test(trimmed)) {
    await sendDiscordMessage(await formatGoogleAdsOauthStartMessage(), targetChannelId)
    return
  }
  if (/google ads.*oauth|ads oauth|keyword planner.*oauth|google ads.*login/i.test(trimmed)) {
    await sendDiscordMessage(await formatGoogleAdsOauthStartMessage(), targetChannelId)
    return
  }
  if (/^(doctor|integrations?|integration doctor|status integrations?)$/i.test(trimmed)) {
    const workspaces = await listWorkspaces().catch(() => [])
    const report = await buildIntegrationDoctorReport(workspaces)
    rememberPendingIntegrationRepair(report, targetChannelId)
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
  const gscCode = extractGscOauthCode(trimmed)
  if (gscCode) {
    await handleGscOauthCode(gscCode, message, targetChannelId)
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
    await sendDiscordMessage(formatStatusMessage(workspace, actions, targetChannelId), targetChannelId)
    return
  }
  if (/^(mål|mal|workspace mål|workspace mal|goals?)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    await sendDiscordMessage(formatWorkspaceProfileMessage(workspace, targetChannelId), targetChannelId)
    return
  }
  if (/^(ranking|rankning|keyword map|keyword-map|keywords?|experiment|seo experiment)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    const review = await buildRankingReview(workspace, targetChannelId).catch((error) => ({ ok: false, error: error?.message || String(error) }))
    await sendDiscordMessage(review.ok ? formatRankingReviewMessage(workspace, review) : `Kunde inte bygga ranking-review: ${review.error || 'okänt fel'}`, targetChannelId)
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
  if (/^(vilket|vilket kort\??|visa kort(et)?\??|skicka kort(et)? igen\??|posta kort(et)? igen\??)$/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    const actions = await fetchActionsForChat(workspace)
    const activeRecord = activeActionRecordFor(workspace, targetChannelId)
    const completedActive = activeRecord?.actionId ? completedCodeActionFor(activeRecord.actionId) : null
    if (completedActive) {
      await sendDiscordMessage(formatCompletedActionAnswer(workspace, activeRecord.actionId, completedActive), targetChannelId)
      return
    }
    const posted = await repostActiveActionCard(workspace, actions, targetChannelId, { intro: /nästa|nasta/i.test(trimmed) ? 'Nästa steg är det här kortet:' : 'Här är kortet jag menar:' })
    if (!posted) await sendDiscordMessage(formatGeneralChatFallback(workspace, actions, targetChannelId, workspaceGuidanceFor(workspace, targetChannelId)), targetChannelId)
    return
  }
  if (/\b(indexerad|indexerat|finns i index|är i google|ar i google)\b/i.test(trimmed)) {
    const workspace = workspaceForChannel(targetChannelId)
    const handled = await handleUserIndexingConfirmation(workspace, targetChannelId, trimmed)
    if (handled) return
  }
  const gscIssueHandled = await maybeHandleGscIssueMessage(trimmed, targetChannelId).catch((error) => {
    log('gsc_issue_message_failed', { channelId: targetChannelId, error: error?.message || String(error) })
    return false
  })
  if (gscIssueHandled) return
  const operatorIntentHandled = await maybeHandleOperatorIntent(trimmed, targetChannelId).catch((error) => {
    log('operator_intent_failed', { channelId: targetChannelId, error: error?.message || String(error) })
    return false
  })
  if (operatorIntentHandled) return
  if (/^(var|vart|hur)\s+(kopplar|connectar|ansluter)\s+(jag\s+)?(gsc|search console)|^(gsc|search console)\s+(hjälp|help|koppling)$/i.test(trimmed)) {
    await sendDiscordMessage('GSC kopplas i Dashboard2 -> SEO Monitor -> Integrations -> Google Search Console. Om du vill kan jag posta kopplingslänken här när du ber mig koppla Search Console. Om OAuth/token fallerar behandlar jag det som integrationsfel, inte som content-commit.', targetChannelId)
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

async function handlePendingIntegrationRepair(targetChannelId) {
  const pending = state.pendingIntegrationRepair?.[targetChannelId]
  if (!pending) {
    await sendDiscordMessage('Jag vet inte vilken integration du vill koppla. Skriv `koppla Search Console` eller `koppla Google Ads`.', targetChannelId)
    return true
  }
  if (pending.expiresAt && Date.parse(pending.expiresAt) < Date.now()) {
    delete state.pendingIntegrationRepair[targetChannelId]
    saveState()
    await sendDiscordMessage('Den senaste integrationsvarningen är gammal. Kör `doctor` först, eller skriv `koppla Search Console` / `koppla Google Ads`.', targetChannelId)
    return true
  }
  if (pending.type === 'gsc') {
    await sendDiscordMessage(await formatGscOauthStartMessage(), targetChannelId)
    return true
  }
  if (pending.type === 'google_ads') {
    await sendDiscordMessage(await formatGoogleAdsOauthStartMessage(), targetChannelId)
    return true
  }
  await sendDiscordMessage('Jag kan inte avgöra vilken integration som ska kopplas. Skriv `koppla Search Console` eller `koppla Google Ads`.', targetChannelId)
  return true
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
  const directDecision = directNaturalDecisionForActiveAction(message)
  if (directDecision) {
    const decisionInput = {
      actionId: active.id,
      decision: directDecision.decision,
      reason: `${directDecision.reason}: ${String(message || '').slice(0, 240)}`,
      source: 'discord_natural_chat',
      discordMessageId: null,
      discordChannelId: targetChannelId
    }
    saveState()
    const runtimeResult = await executeActionDecisionThroughRuntime(decisionInput)
    if (runtimeResult.ok) {
      await saveActionDecisionBestEffort(decisionInput)
    } else {
      await saveActionDecision(decisionInput)
      recordDecisionInLedger(active.id, directDecision.decision, targetChannelId, { source: 'discord_natural_chat', reason: directDecision.reason })
      if (directDecision.decision === 'approved') await rememberApprovedCodeAction(active.id, targetChannelId)
      clearActiveAction(active.id)
      saveState()
    }
    await sendDiscordMessage(directDecision.confirmation(active), targetChannelId)
    return true
  }
  if (!isIndexingCheckAction(active) && !/klar|klart|fixad|fixat|gjord|gjort|hanterad|hanterat|index|google|vänta|vanta|irrelevant|skippa|hoppa|kör|kor|gör|gor|fixa|godkänn|godkann|ta den/i.test(message)) return false
  const intent = await runCodexOperatorIntent({ workspace, activeAction: compactActionForChat(active), message })
  if (intent.intent === 'confirm_indexed' && isIndexingCheckAction(active)) {
    await handleUserIndexingConfirmation(workspace, targetChannelId, message)
    return true
  }
  if (intent.intent === 'mark_handled') {
    const decisionInput = {
      actionId: active.id,
      decision: 'skipped',
      reason: `User confirmed handled in Discord: ${String(message || '').slice(0, 240)}`,
      source: 'discord_operator_intent',
      discordMessageId: null,
      discordChannelId: targetChannelId
    }
    saveState()
    const runtimeResult = await executeActionDecisionThroughRuntime(decisionInput)
    if (runtimeResult.ok) {
      await saveActionDecisionBestEffort(decisionInput)
    } else {
      await saveActionDecision(decisionInput)
      clearActiveAction(active.id)
      saveState()
    }
    await sendDiscordMessage(`Jag markerade kortet som hanterat: ${active.title || active.id}`, targetChannelId)
    return true
  }
  if (intent.intent === 'deprioritize') {
    const decisionInput = {
      actionId: active.id,
      decision: 'deprioritized',
      reason: `User deprioritized in natural language: ${String(message || '').slice(0, 240)}`,
      source: 'discord_operator_intent',
      discordMessageId: null,
      discordChannelId: targetChannelId
    }
    saveState()
    const runtimeResult = await executeActionDecisionThroughRuntime(decisionInput)
    if (runtimeResult.ok) {
      await saveActionDecisionBestEffort(decisionInput)
    } else {
      await saveActionDecision(decisionInput)
      clearActiveAction(active.id)
      saveState()
    }
    await sendDiscordMessage(`Jag prioriterade bort kortet tills vidare: ${active.title || active.id}`, targetChannelId)
    return true
  }
  return false
}

function directNaturalDecisionForActiveAction(message) {
  const text = String(message || '').trim().toLowerCase()
  if (!text) return null
  if (/\b(kör|kor|gör|gor|fixa|bygg|ta den|godkänn|godkann|ja kör|ja kor|ja gör|ja gor)\b/.test(text)) {
    return {
      decision: 'approved',
      reason: 'User approved active card in natural language',
      confirmation: (action) => `Jag tar det aktiva kortet nu: ${action.title || action.id}. Jag kör kodautomation och postar commit/diff när den är klar.`
    }
  }
  if (/\b(skip|skippa|hoppa över|hoppa over|ignorera|inte relevant|fel kort|nej)\b/.test(text)) {
    return {
      decision: 'skipped',
      reason: 'User skipped active card in natural language',
      confirmation: (action) => `Jag hoppar över det aktiva kortet: ${action.title || action.id}. Jag går vidare till nästa bättre SEO-action.`
    }
  }
  if (/\b(vänta|vanta|senare|inte nu|prioritera bort|deprioritera|kan vänta|kan vanta)\b/.test(text)) {
    return {
      decision: 'deprioritized',
      reason: 'User deprioritized active card in natural language',
      confirmation: (action) => `Jag prioriterar ned det aktiva kortet tills vidare: ${action.title || action.id}.`
    }
  }
  return null
}

async function maybeHandleGscIssueMessage(message, targetChannelId) {
  const issue = parseGscIssueMessage(message)
  if (!issue) return false
  const workspace = workspaceForChannel(targetChannelId)
  if (!workspace) {
    await sendDiscordMessage('Jag ser en GSC-varning, men kan inte koppla den till ett workspace i den här kanalen. Posta den i rätt `seo-...` workspace-kanal.', targetChannelId)
    return true
  }
  const action = createGscIssueAction(issue, workspace, targetChannelId)
  state.gscIssues = state.gscIssues || {}
  state.gscIssues[action.id] = {
    ...issue,
    actionId: action.id,
    workspaceId: workspace.id || null,
    workspaceLabel: workspace.label || null,
    channelId: targetChannelId,
    receivedAt: new Date().toISOString(),
    raw: String(message || '').slice(0, 2000)
  }
  ensureWorkspaceProfile(workspace, targetChannelId)
  const review = reviewActionForPosting(action, workspace, targetChannelId, 'GSC issue från Search Console')
  const actionMessage = await buildActionCardMessage(action, 'GSC issue från Search Console', workspace, review, targetChannelId)
  if (!actionMessage) return true
  const posted = await sendDiscordMessage(actionMessage, targetChannelId, actionComponents(action), { kind: 'action_card' })
  const activeKey = activeWorkspaceActionKey(workspace, targetChannelId)
  const runtimePosted = await markActionPostedThroughRuntime({
    action,
    workspace,
    targetChannelId,
    messageId: posted.id,
    activeKey,
    systemKey: gscIssueSeenKey(action, workspace, issue),
    guard: 'gsc_issue_message',
    review
  })
  if (!runtimePosted.ok) {
    state.postedActionIds = state.postedActionIds || {}
    state.postedActionIds[action.id] = {
      messageId: posted.id,
      channelId: targetChannelId,
      title: action.title,
      workspaceId: workspace.id || null,
      postedAt: new Date().toISOString()
    }
    state.activeActionByWorkspace = state.activeActionByWorkspace || {}
    state.activeActionByWorkspace[activeKey] = {
      actionId: action.id,
      messageId: posted.id,
      channelId: targetChannelId,
      workspaceId: workspace.id || null,
      firstPostedAt: new Date().toISOString(),
      postedAt: new Date().toISOString()
    }
    state.messageToAction = state.messageToAction || {}
    state.messageToAction[posted.id] = action.id
    recordActionLedger(action, workspace, targetChannelId, 'posted', { source: 'gsc_issue_message', issueType: issue.type, messageId: posted.id, review })
  }
  rememberAgentLesson(`GSC issue captured for ${workspace.label || workspace.id}: ${issue.type}`)
  saveState()
  return true
}

function parseGscIssueMessage(message) {
  const text = String(message || '')
  const isGsc = /google search console|search console|gsc|canonical|kanonisk|index(ed|ering)|noindex|sitemap|robots|404|redirect/i.test(text)
  if (!isGsc) return null
  if (/duplicate,\s*google chose different canonical than user|google chose different canonical|google valde annan kanonisk|annan canonical|different canonical/i.test(text)) {
    return {
      type: 'duplicate_google_chose_different_canonical',
      title: 'GSC: Duplicate, Google chose different canonical than user',
      severity: 'high',
      affectedUrl: extractFirstUrl(text),
      reason: 'Google ser duplicerat innehåll och väljer en annan canonical än den sajten anger.'
    }
  }
  if (/alternate page with proper canonical|alternativ sida med korrekt kanonisk/i.test(text)) {
    return {
      type: 'alternate_page_with_proper_canonical',
      title: 'GSC: Alternate page with proper canonical',
      severity: 'medium',
      affectedUrl: extractFirstUrl(text),
      reason: 'Google ser sidan som alternativ till en canonical URL.'
    }
  }
  if (/excluded by.*noindex|noindex/i.test(text)) {
    return {
      type: 'excluded_by_noindex',
      title: 'GSC: Excluded by noindex',
      severity: 'high',
      affectedUrl: extractFirstUrl(text),
      reason: 'Sidan blockeras från indexering med noindex.'
    }
  }
  if (/not found|404/i.test(text) && /index/i.test(text)) {
    return {
      type: 'not_found_404',
      title: 'GSC: 404 prevents indexing',
      severity: 'medium',
      affectedUrl: extractFirstUrl(text),
      reason: 'Google hittar URL:er som returnerar 404 eller saknas.'
    }
  }
  return null
}

function createGscIssueAction(issue, workspace, targetChannelId, options = {}) {
  const host = workspaceHost(workspace)
  const path = issue.affectedUrl ? normalizeActionPath(issue.affectedUrl) : '/'
  const id = `gsc_issue_${slugify(workspace?.label || host || targetChannelId)}_${slugify(issue.type)}_${slugify(path || 'site')}`.slice(0, 180)
  return {
    id,
    title: issue.title,
    targetUrl: issue.affectedUrl || (host ? `https://${host}/` : ''),
    url: issue.affectedUrl || (host ? `https://${host}/` : ''),
    keyword: null,
    priority: issue.severity === 'high' ? 'high' : 'medium',
    category: 'technical',
    why: issue.reason,
    recommendedAction: gscIssueRecommendedAction(issue),
    status: 'pending',
    workspaceId: workspace?.id || null,
    workspaceSlug: workspace?.label || null,
    projectSlug: workspace?.repoFullName || null,
    source: options.source || 'gsc_issue_message'
  }
}

function gscIssueRecommendedAction(issue) {
  if (issue.type === 'duplicate_google_chose_different_canonical') {
    return 'Undersök canonical och alias-routes i repo. Säkerställ att bara canonical URL serverar innehåll. Gör gamla alias till redirects eller sätt självcanonical korrekt. Uppdatera interna länkar så de pekar på canonical URL. Bygg, committa och posta GitHub-länk.'
  }
  if (issue.type === 'excluded_by_noindex') return 'Hitta noindex-källa, ta bort den om sidan ska ranka, bygg, committa och posta GitHub-länk.'
  if (issue.type === 'not_found_404') return 'Hitta interna länkar/sitemap till 404-URL:er, redirecta eller ta bort länkar, bygg, committa och posta GitHub-länk.'
  return 'Undersök GSC-felet i repo, gör minsta säkra tekniska SEO-fix, bygg, committa och posta GitHub-länk.'
}

function extractFirstUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s<>"')]+/i)
  return match ? match[0].replace(/[.,;:]+$/, '') : ''
}

function workspaceHost(workspace) {
  const value = String(workspace?.gscProperty || workspace?.id || workspace?.label || '')
  const first = value.split('__')[0]
  if (first.startsWith('sc-domain:')) return first.replace(/^sc-domain:/, '')
  try { return new URL(first).hostname.replace(/^www\./, '') } catch {}
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(first)) return first
  return ''
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
    command: `${codexCli} exec --json --cd /home/deploy/seo-agent-discord --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`,
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
  const decisionInput = {
    actionId: action.id,
    decision: 'skipped',
    reason: `User confirmed indexed in Discord: ${String(message || '').slice(0, 240)}`,
    source: 'discord_indexing_confirmation',
    discordMessageId: null,
    discordChannelId: targetChannelId
  }
  saveState()
  const runtimeResult = await executeActionDecisionThroughRuntime(decisionInput)
  if (runtimeResult.ok) {
    await saveActionDecisionBestEffort(decisionInput)
  } else {
    await saveActionDecision(decisionInput)
    clearActiveAction(action.id)
  }
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
  const completedActive = activeId ? completedCodeActionFor(activeId) : null
  const active = activeId ? actions.find((item) => item.id === activeId) : null
  const ledgerFallbackActions = ledgerActionsForWorkspace(workspace, targetChannelId).slice(0, 8)
  const recentCompleted = recentCompletedCodeActionsForWorkspace(workspace).slice(0, 5)
  const pending = actions.filter((item) => item.status === 'pending').slice(0, 8)
  const chatActions = pending.length ? pending : ledgerFallbackActions
  const actionBoard = buildWorkspaceActionBoard(workspace, payload, targetChannelId)
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
    activeAction: completedActive ? null : active ? compactActionForChat(active) : null,
    completedActiveAction: completedActive ? compactCompletedCodeAction(activeId, completedActive, workspace) : null,
    recentCompletedCodeActions: recentCompleted.map(([id, result]) => compactCompletedCodeAction(id, result, workspace)),
    actionBoard,
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
    'Du kan och ska ha vanlig konversation. Textkommandon är inte användargränssnittet. Om användaren frågar något, svara direkt först.',
    'Du kan ha strategiskt resonemang, men håll svaret konkret.',
    'Du är inte bara en kommandobot. Om användaren frågar vad som är smart ska du resonera utifrån mål, workspace-policy, kö, repo och datastatus.',
    'Använd workspace-kontexten. Om användaren ger riktning, bekräfta vad du sparar och hur det ändrar prioritering.',
    'Om befintlig kö inte matchar användarens riktning, säg det tydligt och föreslå att skapa research/new-page-action eller deprioritera fel action.',
    'Om CONTEXT JSON visar actionsFetchError eller resourceLimitFallback: säg kort att live-datakällan är begränsad, men använd ledgerFallbackActions/pendingActions för konkret nästa steg.',
    'Om pendingActions kommer från ledgerFallbackActions: säg inte att det saknas approve-ready action. Välj bästa ledger-kortet eller säg att det är ett minneskort som kan behöva repost/approve.',
    'Om pendingActions är tom men användaren frågar om nästa steg: föreslå en konkret SEO-riktning och säg vilken integration/datadel som behöver friskna till.',
    'Om completedActiveAction finns: säg att kortet redan är kodat/committat, länka commit, sammanfatta vad som ändrades och föreslå Backa bara om användaren inte gillar ändringen.',
    'Om användaren frågar om en redan skapad commit eller “vad hände”: använd recentCompletedCodeActions före att föreslå nya kommandon.',
    'Använd actionBoard när användaren frågar vad som ska göras nu, om kön, eller varför inget händer. Svara med klara kategorier: klart, gör nu, kandidater, blockerad, bortprioriterad.',
    'Om actionBoard.nextRecommended finns: gör den till tydligt nästa steg. Om den redan körs/är klar, säg det och gå till nästa relevanta item.',
    'Säg inte att något väntar på användarens beslut som default. Agenten beslutar själv för låg-risk content/kod. Be bara om input vid hög risk, ny sida, oklar riktning, blockerad integration eller konflikt med workspace-mål.',
    'Säg inte att du är i pilotläge. Kodautomation är aktiv om context.automation.codeAutomationEnabled är true.',
    'Du får inte låtsas att du har kört kod eller skickat mail.',
    'Nämn inte textkommandon som approve/skip/status/doctor/why. Om beslut behövs: säg att användaren kan trycka knappen eller skriva vanlig svenska som “kör den”, “hoppa över” eller “vänta med den”.',
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
    command: `${codexCli} exec --json --cd /home/deploy/seo-agent-discord --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`,
    timeout: 4 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024
  })
  const output = extractCodexExecText(result.stdout || '')
  return (output || 'Jag kunde inte formulera ett Codex-svar just nu. Jag kan fortfarande läsa kön och svara igen om du frågar vad nästa rimliga steg är.').slice(0, 1900)
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

function buildWorkspaceActionBoard(workspace, payload, targetChannelId) {
  const actions = Array.isArray(payload?.actions) ? payload.actions : []
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const board = {
    generatedAt: new Date().toISOString(),
    workspace: workspace?.label || workspace?.id || 'workspace',
    dataStatus: {
      fetchError: payload?.error || null,
      resourceLimitFallback: payload?.resourceLimitFallback || null,
      liveActionCount: actions.length
    },
    counts: { done: 0, doing: 0, waiting: 0, blocked: 0, deprioritized: 0, ignored: 0 },
    done: [],
    doing: [],
    waiting: [],
    blocked: [],
    deprioritized: [],
    ignored: [],
    nextRecommended: null,
    notes: []
  }
  const seen = new Set()
  for (const action of prioritizeActionQueue(actions, workspace, targetChannelId)) {
    const item = boardItemForAction(action, workspace, targetChannelId, profile)
    if (!item?.id || seen.has(item.id)) continue
    seen.add(item.id)
    pushBoardItem(board, item)
  }
  for (const [actionId, result] of recentCompletedCodeActionsForWorkspace(workspace).slice(0, 8)) {
    if (seen.has(actionId)) continue
    seen.add(actionId)
    pushBoardItem(board, {
      id: actionId,
      title: result?.result?.summary || titleFromActionId(actionId),
      status: 'done',
      reason: 'commit finns i agentens kodhistorik',
      commit: result?.result?.commit || '',
      commitUrl: githubCommitUrl(result?.result?.repoFullName || workspace?.repoFullName || '', result?.result?.commit || ''),
      targetUrl: '',
      category: 'code',
      priority: 'done'
    })
  }
  const noCandidate = state.noAutonomousCandidate?.[workspaceProfileKey(workspace, targetChannelId)]
  if (noCandidate) {
    board.notes.push({
      type: 'no_autonomous_candidate',
      at: noCandidate.at,
      pendingCount: noCandidate.pendingCount,
      reasons: (noCandidate.reasons || []).slice(0, 6)
    })
  }
  board.nextRecommended = chooseBoardNextRecommended(board, profile)
  board.summary = [
    `${board.counts.done} klara`,
    `${board.counts.doing} körs`,
    `${board.counts.waiting} kandidater`,
    `${board.counts.blocked} blockerade`,
    `${board.counts.deprioritized} bortprioriterade`
  ].join(', ')
  return trimBoard(board)
}

function boardItemForAction(action, workspace, targetChannelId, profile) {
  if (!action?.id) return null
  const codeResult = state.codeActionResults?.[action.id]
  const ledger = state.actionLedger?.[actionLearningKey(action, workspace, targetChannelId)]
  const guarded = state.guardedActions?.[actionLearningKey(action, workspace, targetChannelId)]
  const targetUrl = action.targetUrl || action.url || ''
  const base = {
    id: action.id,
    title: action.title || action.id,
    targetUrl,
    keyword: action.keyword || '',
    priority: action.priority || 'medium',
    category: action.category || actionKindForLearning(action),
    commit: codeResult?.result?.commit || ledger?.commit || '',
    commitUrl: githubCommitUrl(codeResult?.result?.repoFullName || workspace?.repoFullName || '', codeResult?.result?.commit || ledger?.commit || ''),
    reason: action.priorityReason || action.why || ''
  }
  if (codeResult?.status === 'completed' || (ledger?.status === 'completed' && !isLedgerRecheckDue(ledger))) {
    return { ...base, status: 'done', reason: base.reason || 'genomförd och väntar på ny recheck' }
  }
  if (state.codeActionRunning?.actionId === action.id || ledger?.status === 'coding') {
    return { ...base, status: 'doing', reason: 'kodautomation körs just nu' }
  }
  if (state.approvedCodeActionQueue?.[action.id] || action.status === 'approved' || ledger?.status === 'approved') {
    return { ...base, status: 'doing', reason: 'godkänd/köad för kodautomation' }
  }
  if (codeResult?.status && codeResult.status !== 'completed') {
    return { ...base, status: 'blocked', reason: codeResult.failure?.operatorSummary || codeResult.error || `kodresultat: ${codeResult.status}` }
  }
  if (action.status === 'skipped' || ledger?.status === 'ignored') {
    return { ...base, status: 'ignored', reason: 'skippad eller markerad som hanterad' }
  }
  if (action.status === 'deprioritized' || (ledger?.status === 'deprioritized' && !isLedgerRecheckDue(ledger))) {
    return { ...base, status: 'deprioritized', reason: 'bortprioriterad tills ny recheck' }
  }
  if (guarded && !isLedgerRecheckDue(ledger)) {
    return { ...base, status: 'deprioritized', reason: `stoppad av guard: ${guarded.reason}` }
  }
  if (isIndexingCheckAction(action)) {
    return { ...base, status: 'blocked', reason: 'GSC/indexering kräver browser/GSC-kontroll, inte vanlig content-commit' }
  }
  const text = actionText(action)
  const avoided = (profile.avoid || []).some((term) => text.includes(normalizeForMatch(term)))
  const preferred = (profile.prefer || []).some((term) => text.includes(normalizeForMatch(term)))
  if (avoided && !preferred) {
    return { ...base, status: 'deprioritized', reason: 'matchar lågprioriterat spår för workspacet' }
  }
  if (!targetUrl && isCodeAction(action)) {
    return { ...base, status: 'blocked', reason: 'saknar target-URL, behöver research eller tydligare uppgift innan kod' }
  }
  return { ...base, status: 'waiting', reason: base.reason || 'kandidat för autonom prioritering' }
}

function pushBoardItem(board, item) {
  const bucket = ['done', 'doing', 'waiting', 'blocked', 'deprioritized', 'ignored'].includes(item.status) ? item.status : 'waiting'
  board[bucket].push(item)
  board.counts[bucket] += 1
}

function chooseBoardNextRecommended(board, profile) {
  if (board.doing.length) return { ...board.doing[0], nextReason: 'pågår redan' }
  const waiting = board.waiting
    .filter((item) => item.targetUrl)
    .filter((item) => {
      const text = actionText(item)
      return !(profile.avoid || []).some((term) => text.includes(normalizeForMatch(term)))
        || (profile.prefer || []).some((term) => text.includes(normalizeForMatch(term)))
    })
  if (waiting.length) return { ...waiting[0], nextReason: 'bästa kvarvarande action med target-URL' }
  if (board.blocked.length) return { ...board.blocked[0], nextReason: 'blockerande sak att lösa innan fler actions' }
  return null
}

function trimBoard(board) {
  const limitItems = (items) => items.slice(0, 8).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority,
    category: item.category,
    targetUrl: item.targetUrl,
    keyword: item.keyword,
    reason: String(item.reason || '').slice(0, 260),
    commit: item.commit,
    commitUrl: item.commitUrl,
    nextReason: item.nextReason
  }))
  return {
    ...board,
    done: limitItems(board.done),
    doing: limitItems(board.doing),
    waiting: limitItems(board.waiting),
    blocked: limitItems(board.blocked),
    deprioritized: limitItems(board.deprioritized),
    ignored: limitItems(board.ignored),
    nextRecommended: board.nextRecommended ? limitItems([board.nextRecommended])[0] : null
  }
}

function titleFromActionId(actionId) {
  return String(actionId || '')
    .replace(/^seo_(action|synthetic)_/, '')
    .replace(/[_-]+/g, ' ')
    .slice(0, 140)
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
  const review = reviewActionForPosting(enrichedAction, workspace, targetChannelId, payload.workspacePolicy)
  const actionMessage = await buildActionCardMessage(enrichedAction, payload.workspacePolicy, workspace, review, targetChannelId)
  if (!actionMessage) return null
  const message = [
    options.intro || 'Här är kortet jag menar:',
    actionMessage
  ].join('\n\n')
  const posted = await sendDiscordMessage(message, targetChannelId, actionComponents(enrichedAction))
  const runtimePosted = await markActionPostedThroughRuntime({
    action: enrichedAction,
    workspace,
    targetChannelId,
    messageId: posted.id,
    activeKey,
    guard: 'repost_active_action',
    review
  })
  if (!runtimePosted.ok) {
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
  }
  saveState()
  return posted
}

function discordMessageUrl(targetChannelId, messageId) {
  if (!targetChannelId || !messageId) return ''
  return `https://discord.com/channels/${guildId || '@me'}/${targetChannelId}/${messageId}`
}

function formatGeneralChatFallback(workspace, payload, targetChannelId, guidance = null) {
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const board = buildWorkspaceActionBoard(workspace, payload, targetChannelId)
  const activeRecord = activeActionRecordFor(workspace, targetChannelId)
  const activeId = activeRecord?.actionId || null
  const completedActive = activeId ? completedCodeActionFor(activeId) : null
  if (completedActive) return formatCompletedActionAnswer(workspace, activeId, completedActive)
  const active = activeId ? actions.find((item) => item.id === activeId) : null
  const ledgerFallback = ledgerActionsForWorkspace(workspace, targetChannelId)
  const next = active || board.nextRecommended || actions.find((item) => item.status === 'pending') || actions[0] || ledgerFallback[0]
  const label = workspace?.label || workspace?.id || 'workspace'
  const cardUrl = activeRecord?.messageId ? discordMessageUrl(activeRecord.channelId || targetChannelId, activeRecord.messageId) : ''
  if (!next && activeRecord?.actionId) {
    return [
      `Nästa steg för ${label}: det finns fortfarande ett aktivt SEO-kort i kandidatkön.`,
      `Kort-ID: \`${activeRecord.actionId}\``,
      cardUrl ? `Kort: ${cardUrl}` : 'Jag kan posta kortet igen med knappar om du ber om det.',
      'Jag hittar inte kortet i senaste topp-listan från SEO Monitor, men det är fortfarande markerat som aktivt i agentens kö. Om det är låg risk ska jag avgöra själv; om det verkar fel kan du säga det i vanlig svenska.'
    ].join('\n').slice(0, 1900)
  }
  if (!next) return [
    `Nästa steg för ${label}: jag hittar ingen säker pending SEO-action just nu.`,
    `Board: ${board.summary}.`,
    board.notes?.length ? `Senaste urvalsskäl: ${JSON.stringify(board.notes[0]).slice(0, 500)}` : 'Jag fortsätter bevaka ny SEO-data och integrationer.'
  ].join('\n').slice(0, 1900)
  const why = next.priorityReason || next.why || next.reason || 'Den ligger högst i aktuell SEO-kö.'
  return [
    `Nästa steg för ${label}: ${next.title}.`,
    `Board: ${board.summary}.`,
    cardUrl ? `Kort: ${cardUrl}` : 'Jag kan posta kortet igen med knappar om du vill.',
    `Varför: ${String(why).slice(0, 260)}`,
    'Jag avgör själv om det är låg risk och kör vidare. Om du inte håller med kan du säga att jag ska hoppa över eller vänta med den.',
    'Jag kan också sammanfatta tidigare commits om du frågar vad som redan skapats.'
  ].join('\n').slice(0, 1900)
}

function completedCodeActionFor(actionId) {
  const result = state.codeActionResults?.[actionId]
  return result?.status === 'completed' ? result : null
}

function recentCompletedCodeActionsForWorkspace(workspace) {
  const repo = String(workspace?.repoFullName || '').toLowerCase()
  const repoName = repo.split('/').pop()
  const label = String(workspace?.label || workspace?.id || '').toLowerCase()
  return Object.entries(state.codeActionResults || {})
    .filter(([, result]) => result?.status === 'completed')
    .filter(([id, result]) => {
      const haystack = `${id} ${result?.result?.repoFullName || ''} ${result?.result?.repoDir || ''}`.toLowerCase()
      return !repoName || haystack.includes(repoName) || haystack.includes(repo) || haystack.includes(label)
    })
    .sort((a, b) => Date.parse(b[1].completedAt || 0) - Date.parse(a[1].completedAt || 0))
}

function compactCompletedCodeAction(actionId, resultRecord, workspace) {
  const result = resultRecord?.result || {}
  const repoFullName = result.repoFullName || workspace?.repoFullName || ''
  const commit = result.commit || ''
  return {
    actionId,
    status: resultRecord?.status || '',
    completedAt: resultRecord?.completedAt || '',
    commit,
    commitUrl: githubCommitUrl(repoFullName, commit),
    repoFullName,
    branch: result.branch || workspace?.branch || 'main',
    diffStat: result.diffStat || '',
    summary: result.summary || result.operatorSummary || ''
  }
}

function formatCompletedActionAnswer(workspace, actionId, resultRecord) {
  const item = compactCompletedCodeAction(actionId, resultRecord, workspace)
  return [
    `Den actionen är redan kodad och committad för ${workspace?.label || workspace?.id || 'workspacet'}.`,
    item.commit ? `Commit: ${item.commit}` : '',
    item.commitUrl ? `GitHub: ${item.commitUrl}` : '',
    item.diffStat ? `Diff:\n${String(item.diffStat).slice(0, 500)}` : '',
    item.summary ? `Sammanfattning: ${String(item.summary).slice(0, 280)}` : '',
    'Nästa: om ändringen ser bra ut behöver du inte göra något. Om den blev fel, använd Backa-knappen på commit-meddelandet eller säg i chatten vad som blev fel.'
  ].filter(Boolean).join('\n').slice(0, 1900)
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
  const doctor = await runGscDoctorThroughRuntime({ includeBrowser: true }).catch(() => null)
  const result = doctor?.browser || { ok: false, status: 'runtime_doctor_unavailable', error: 'GSC doctor måste gå via SEO runtime.' }
  return [
    'GSC Firefox UI tool',
    `Status: ${result.ok ? 'redo' : 'inte redo'}`,
    result.container ? `Container: ${result.container}` : '',
    result.mode ? `Mode: ${result.mode}` : '',
    result.error ? `Fel: ${result.error}` : '',
    'Detta styr den inloggade noVNC-Firefoxen. Används för GSC-flöden som Google blockerar i Selenium.'
  ].filter(Boolean).join('\n')
}

async function runGscDoctorThroughRuntime(input = {}) {
  const response = await fetch(`${seoRuntimeUrl}/seo/integrations/gsc/doctor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok || payload?.ok === false && !payload?.api && !payload?.browser) {
    throw new Error(payload?.error || payload?.detail || text || `runtime_gsc_doctor_http_${response.status}`)
  }
  return payload
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
  const runtimeStart = await startGscOauthThroughRuntime().catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (runtimeStart.ok) {
    return [
      'Google Search Console OAuth för SEO-agentens URL Inspection API:',
      runtimeStart.authorizationUrl,
      '',
      ...formatNoVncAccessLines(),
      '',
      `Redirect URI: ${runtimeStart.redirectUri || gscOauthRedirectUri}`,
      'Om Google kräver manuell login/approval: gör den i noVNC-Firefox och skriv sedan `klart` eller `gsc read browser` här.',
      'Om callbacken landar på en sida med fel men URL:en fortfarande innehåller `code=...`: klistra in hela URL:en eller skriv `gsc code ...`.',
      'Agenten sparar refresh-token lokalt på VPS och använder API:t före noVNC/Firefox.'
    ].join('\n')
  }
  if (gscClientId() && gscClientSecret()) {
    return `GSC OAuth kunde inte starta via runtime: ${runtimeStart.error || runtimeStart.status || 'okänt fel'}`
  }
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
        'När flödet är klart kan du säga till här, så verifierar jag kopplingen.'
      ].join('\n')
    }
    return `GSC OAuth kunde inte starta: ${JSON.stringify(payload).slice(0, 500)}`
  } catch (error) {
    return `GSC OAuth kunde inte starta: ${error?.message || String(error)}`
  }
}

async function startGscOauthThroughRuntime() {
  const response = await fetch(`${seoRuntimeUrl}/seo/integrations/gsc/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok || !payload?.ok || !payload.authorizationUrl) {
    throw new Error(payload?.error || payload?.status || text || `runtime_gsc_oauth_start_http_${response.status}`)
  }
  return payload
}

function gscClientId() {
  return env.GSC_CLIENT_ID || env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || ''
}

function gscClientSecret() {
  return env.GSC_CLIENT_SECRET || env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || ''
}

function extractGscOauthCode(content) {
  const direct = content.match(/(?:^|\s)(?:gsc code|search console code)[:=\s]+([A-Za-z0-9._~+-]+)/i)
  if (direct?.[1]) return direct[1]
  try {
    const url = new URL(content.match(/https?:\/\/\S+/)?.[0] || content)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state === gscOauthState) return code
  } catch {}
  return null
}

async function handleGscOauthCode(code, message, targetChannelId) {
  if (!gscClientId() || !gscClientSecret()) {
    await sendDiscordMessage('Kan inte växla GSC-koden: OAuth client saknas i agentens env.', targetChannelId)
    return
  }
  try {
    const exchanged = await exchangeGscOauthCodeThroughRuntime(code)
    if (!exchanged.ok) {
      await sendDiscordMessage(exchanged.status === 'missing_refresh_token'
        ? 'Google svarade utan GSC refresh token. Be mig starta om GSC OAuth och godkänn hela consent-flödet igen.'
        : `GSC OAuth misslyckades: ${exchanged.error || exchanged.status || 'okänt fel'}`, targetChannelId)
      return
    }
    const doctor = exchanged.doctor || { ok: false, status: 'doctor_missing' }
    await sendDiscordMessage([
      'GSC OAuth lyckades. Refresh-token är sparad lokalt på VPS:en.',
      doctor.ok ? 'URL Inspection API är redo.' : `URL Inspection API är fortfarande inte redo: ${doctor.error || doctor.status || 'okänt fel'}`
    ].join('\n'), targetChannelId)
    log('gsc_oauth_refresh_token_saved', { discordMessageId: message.id, channelId: targetChannelId, apiReady: Boolean(doctor.ok) })
  } catch (error) {
    await sendDiscordMessage(`GSC OAuth misslyckades: ${error?.message || String(error)}`, targetChannelId)
  }
}

async function exchangeGscOauthCodeThroughRuntime(code) {
  const response = await fetch(`${seoRuntimeUrl}/seo/integrations/gsc/oauth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok || !payload) throw new Error(text || `runtime_gsc_oauth_exchange_http_${response.status}`)
  return payload
}

async function openGscOauthInFirefox() {
  if (!gscClientId() || !gscClientSecret()) {
    return [
      'GSC OAuth kan inte starta i browsern: SEO-agenten saknar GSC_CLIENT_ID eller GSC_CLIENT_SECRET på VPS:en.',
      'Be mig kontrollera integrationsstatusen när env är uppdaterad.'
    ].join('\n')
  }
  const runtimeStart = await startGscOauthThroughRuntime().catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (!runtimeStart.ok) return `GSC OAuth kunde inte starta via runtime: ${runtimeStart.error || runtimeStart.status || 'okänt fel'}`
  const authUrl = runtimeStart.authorizationUrl
  const result = await runGscFirefoxUiTool({ command: 'open-url', url: authUrl }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (!result.ok) {
    return [
      'Kunde inte öppna GSC OAuth i noVNC-Firefox.',
      `Fel: ${result.error || result.status || 'unknown'}`,
      '',
      ...formatNoVncAccessLines(),
      '',
      'Fallback: öppna länken manuellt och klistra tillbaka callback-URL:en här.',
      authUrl
    ].join('\n')
  }
  state.pendingBrowserOauth = {
    type: 'gsc',
    startedAt: new Date().toISOString()
  }
  saveState()
  const completed = await runGscFirefoxUiTool({ command: 'complete-oauth' }).catch((error) => ({ ok: false, status: 'complete_oauth_failed', error: error?.message || String(error) }))
  const completedCode = completed.ok ? extractGscOauthCode(completed.currentUrl || '') : ''
  if (completedCode) {
    try {
      const exchanged = await exchangeGscOauthCodeThroughRuntime(completedCode)
      if (exchanged.ok) {
        const doctor = exchanged.doctor || { ok: false, status: 'doctor_missing' }
        state.pendingBrowserOauth = null
        saveState()
        return [
          'GSC OAuth öppnades, agenten nådde callbacken själv och refresh-token är sparad.',
          doctor.ok ? 'URL Inspection API är redo.' : `URL Inspection API är fortfarande inte redo: ${doctor.error || doctor.status || 'okänt fel'}`
        ].join('\n')
      }
    } catch (error) {
      return `GSC OAuth nådde callback, men token-växlingen misslyckades: ${error?.message || String(error)}`
    }
    return [
      'GSC OAuth öppnades och agenten nådde callbacken själv.',
      'Skriv `klart` om du vill att jag läser callbacken igen, annars sparar jag token när Discord-kommandot körs med callback-code.',
      'Notis: om callbacken hanteras av den publika SEO API:n kan token redan vara sparad där.'
    ].join('\n')
  }
  return [
    'GSC OAuth är öppnad i VPS-Firefox.',
    '',
    `Öppna: ${noVncUrl}`,
    completed.status === 'manual_login_required' ? 'Google kräver manuell login/2FA; jag stoppar där av säkerhetsskäl.' : '',
    completed.status === 'callback_not_reached' ? 'Jag försökte välja konto/godkänna automatiskt men nådde inte callback ännu.' : '',
    completed.status === 'oauth_error' ? 'Google visade OAuth-fel; be mig köra doctor om du vill se aktuell URL.' : '',
    '',
    'Gör login/godkännande där och skriv `klart` här efteråt.',
    noVncTunnelCommand ? `Om länken inte öppnas: \`${noVncTunnelCommand}\`` : ''
  ].filter(Boolean).join('\n')
}

async function readGscOauthFromFirefox(message, targetChannelId) {
  const result = await runGscFirefoxUiTool({ command: 'current-url' }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (!result.ok) {
    await sendDiscordMessage(`Kunde inte läsa Firefox-URL: ${result.error || result.status || 'unknown'}`, targetChannelId)
    return false
  }
  const currentUrl = String(result.currentUrl || '').trim()
  const code = extractGscOauthCode(currentUrl)
  if (!code) {
    await sendDiscordMessage([
      'Jag läste Firefox-URL:en men hittade ingen GSC OAuth-code ännu.',
      currentUrl ? `Nuvarande URL: ${currentUrl.slice(0, 220)}` : 'Nuvarande URL saknas.',
      'När browsern visar localhost-callbacken kan du säga “klart” här, så läser jag URL:en igen.'
    ].join('\n'), targetChannelId)
    return false
  }
  await handleGscOauthCode(code, message, targetChannelId)
  if (state.pendingBrowserOauth?.type === 'gsc') {
    state.pendingBrowserOauth = null
    saveState()
  }
  return true
}

async function readPendingOauthFromFirefox(message, targetChannelId) {
  const pending = state.pendingBrowserOauth?.type || ''
  if (pending === 'gsc') return readGscOauthFromFirefox(message, targetChannelId)
  if (pending === 'google_ads') {
    await readGoogleAdsOauthFromFirefox(message, targetChannelId)
    return true
  }
  const result = await runGscFirefoxUiTool({ command: 'current-url' }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (!result.ok) return false
  const currentUrl = String(result.currentUrl || '').trim()
  if (extractGscOauthCode(currentUrl)) return readGscOauthFromFirefox(message, targetChannelId)
  if (extractGoogleAdsOauthCode(currentUrl)) {
    await readGoogleAdsOauthFromFirefox(message, targetChannelId)
    return true
  }
  return false
}

async function formatGoogleAdsOauthStartMessage() {
  const runtimeStart = await startGoogleAdsOauthThroughRuntime().catch((error) => ({ ok: false, error: error?.message || String(error) }))
  const authUrl = runtimeStart.ok ? runtimeStart.authorizationUrl : ''
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET) {
    return [
      'Google Ads OAuth kan inte starta: SEO-agenten saknar GOOGLE_ADS_CLIENT_ID eller GOOGLE_ADS_CLIENT_SECRET på VPS:en.',
      'Codex behöver synka Ads-modulens OAuth client till agentens env först.'
    ].join('\n')
  }
  return [
    'Google Ads OAuth: öppna länken, logga in med kontot som har Google Ads-access och godkänn.',
    authUrl || `Kunde inte skapa OAuth-länk via runtime: ${runtimeStart.error || runtimeStart.status || 'okänt fel'}`,
    '',
    'Efteråt kan browsern hamna på localhost och visa fel. Det är okej: kopiera hela URL:en från adressfältet eller bara `code=...` och klistra in här.',
    'Agenten skriver aldrig ut refresh token i Discord.'
  ].join('\n')
}

async function startGoogleAdsOauthThroughRuntime() {
  const response = await fetch(`${seoRuntimeUrl}/seo/integrations/google-ads/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok || !payload?.ok || !payload.authorizationUrl) {
    throw new Error(payload?.error || payload?.status || text || `runtime_google_ads_oauth_start_http_${response.status}`)
  }
  return payload
}

async function openGoogleAdsOauthInFirefox() {
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET) {
    return [
      'Google Ads OAuth kan inte starta i browsern: SEO-agenten saknar GOOGLE_ADS_CLIENT_ID eller GOOGLE_ADS_CLIENT_SECRET på VPS:en.',
      'Be mig kontrollera integrationsstatusen när env är uppdaterad.'
    ].join('\n')
  }
  const runtimeStart = await startGoogleAdsOauthThroughRuntime().catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (!runtimeStart.ok) return `Google Ads OAuth kunde inte starta via runtime: ${runtimeStart.error || runtimeStart.status || 'okänt fel'}`
  const authUrl = runtimeStart.authorizationUrl
  const result = await runGscFirefoxUiTool({ command: 'open-url', url: authUrl }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (!result.ok) {
    return [
      'Kunde inte öppna Google Ads OAuth i noVNC-Firefox.',
      `Fel: ${result.error || result.status || 'unknown'}`,
      '',
      'Fallback: be mig posta OAuth-länken här i chatten och öppna den manuellt.'
    ].join('\n')
  }
  state.pendingBrowserOauth = {
    type: 'google_ads',
    startedAt: new Date().toISOString()
  }
  saveState()
  return [
    'Google Ads OAuth är öppnad i noVNC-Firefox.',
    'Logga in/godkänn där. När browsern landar på localhost-callback kan du säga “klart”, så läser jag callbacken.',
    'Om Google kräver manuell login är det väntat; agenten läser callbacken efteråt och sparar token själv.'
  ].join('\n')
}

async function readGoogleAdsOauthFromFirefox(message, targetChannelId) {
  const result = await runGscFirefoxUiTool({ command: 'current-url' }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
  if (!result.ok) {
    await sendDiscordMessage(`Kunde inte läsa Firefox-URL: ${result.error || result.status || 'unknown'}`, targetChannelId)
    return
  }
  const currentUrl = String(result.currentUrl || '').trim()
  const code = extractGoogleAdsOauthCode(currentUrl)
  if (!code) {
    await sendDiscordMessage([
      'Jag läste Firefox-URL:en men hittade ingen Google Ads OAuth-code ännu.',
      currentUrl ? `Nuvarande URL: ${currentUrl.slice(0, 220)}` : 'Nuvarande URL saknas.',
      'När browsern visar localhost-callbacken kan du säga “klart” här, så läser jag URL:en igen.'
    ].join('\n'), targetChannelId)
    return
  }
  await handleGoogleAdsOauthCode(code, message, targetChannelId)
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
    const exchanged = await exchangeGoogleAdsOauthCodeThroughRuntime(code)
    if (!exchanged.ok) {
      await sendDiscordMessage('Google svarade utan refresh token. Be mig starta om Google Ads-kopplingen och godkänn hela consent-flödet igen.', targetChannelId)
      return
    }
    const platformSync = exchanged.platformSync || { ok: false, error: 'platform_sync_missing' }
    const statusLines = [
      'Google Ads OAuth lyckades. Ny refresh token är sparad lokalt på VPS:en.',
      platformSync.ok
        ? `Platform API är uppdaterad och Keyword Planner-status är ${platformSync.keywordPlannerStatus || 'okänd'}.`
        : `Platform API kunde inte uppdateras automatiskt: ${platformSync.error}`,
    ]
    if (!platformSync.ok) statusLines.push('Agenten behåller token lokalt och kan kontrollera exakt vad som saknas tills platform-sync fungerar.')
    await sendDiscordMessage(statusLines.join('\n'), targetChannelId)
    log('google_ads_oauth_refresh_token_saved', {
      discordMessageId: message.id,
      channelId: targetChannelId,
      platformSynced: platformSync.ok,
      keywordPlannerStatus: platformSync.keywordPlannerStatus || null,
      error: platformSync.error || null
    })
  } catch (error) {
    await sendDiscordMessage(`Google Ads OAuth misslyckades: ${error?.message || String(error)}`, targetChannelId)
  }
}

async function exchangeGoogleAdsOauthCodeThroughRuntime(code) {
  const response = await fetch(`${seoRuntimeUrl}/seo/integrations/google-ads/oauth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok || !payload) throw new Error(text || `runtime_google_ads_oauth_exchange_http_${response.status}`)
  return payload
}

async function syncGoogleAdsRefreshTokenToPlatform(refreshToken) {
  try {
    const payload = await fetchPlatformJson('/api/platform/ad-automation/google-ads/oauth-token', {
      method: 'PUT',
      body: JSON.stringify({ refreshToken })
    })
    return {
      ok: Boolean(payload?.stored),
      verified: Boolean(payload?.verified),
      keywordPlannerStatus: payload?.keywordPlannerStatus || payload?.status || '',
      error: payload?.error || ''
    }
  } catch (error) {
    return {
      ok: false,
      verified: false,
      keywordPlannerStatus: '',
      error: error?.message || String(error)
    }
  }
}

function loadGoogleAdsRefreshToken() {
  const tokenPath = join(stateDir, 'google-ads-refresh-token.txt')
  if (!existsSync(tokenPath)) return ''
  return readFileSync(tokenPath, 'utf8').trim()
}

async function selfHealGoogleAdsKeywordPlanner() {
  const refreshToken = loadGoogleAdsRefreshToken()
  if (!refreshToken) return { attempted: false, ok: false, error: 'local_refresh_token_missing' }
  const sync = await syncGoogleAdsRefreshTokenToPlatform(refreshToken)
  if (!sync.ok) return { attempted: true, ok: false, error: sync.error || 'platform_sync_failed' }
  try {
    const payload = await fetchPlatformJson('/api/platform/ad-automation/keyword-metrics', {
      method: 'POST',
      body: JSON.stringify({ keywords: ['ai agenter företag'] })
    })
    return {
      attempted: true,
      ok: payload?.status === 'ready',
      payload,
      keywordPlannerStatus: payload?.status || sync.keywordPlannerStatus || '',
      error: payload?.status === 'ready' ? '' : payload?.error || payload?.status || 'keyword_planner_not_ready'
    }
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: error?.message || String(error),
      keywordPlannerStatus: sync.keywordPlannerStatus || ''
    }
  }
}

async function fetchActionsForChat(workspace) {
  return fetchSeoMonitorActions(workspace, 12).catch((error) => ({ error: error?.message || String(error), actions: [] }))
}

async function fetchSeoMonitorActions(workspace, limit) {
  const runtimePayload = await fetchSeoMonitorActionsViaRuntime(workspace, limit)
  if (runtimePayload) return runtimePayload
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

async function fetchSeoMonitorActionsViaRuntime(workspace, limit, options = {}) {
  const workspaceKey = encodeURIComponent(workspaceProfileKey(workspace, null))
  const cacheTtlMs = Number(env.SEO_RUNTIME_LIVE_ACTIONS_CACHE_MS || String(2 * 60 * 1000))
  const cacheKey = `${workspaceKey}:${limit}:${options.includeGscProperty !== false ? 'gsc' : 'repo'}`
  const cached = runtimeLiveActionsCache.get(cacheKey)
  if (cached && Date.now() - cached.at < cacheTtlMs) {
    return JSON.parse(JSON.stringify(cached.payload))
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(env.SEO_RUNTIME_FETCH_TIMEOUT_MS || '10000'))
  try {
    const response = await fetch(`${seoRuntimeUrl}/seo/workspaces/${workspaceKey}/actions/live`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace,
        limit,
        includeGscProperty: options.includeGscProperty !== false
      })
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text }
    }
    if (!response.ok || payload?.ok === false || !Array.isArray(payload?.actions)) {
      throw new Error(payload?.error || payload?.detail || text || `runtime_live_http_${response.status}`)
    }
    log('runtime_live_actions_fetched', {
      workspace: workspace?.label || workspace?.id || workspace?.repoFullName || null,
      limit,
      actionCount: payload.actions.length
    })
    const runtimeResult = {
      actions: payload.actions,
      workspacePolicy: payload.workspacePolicy || '',
      workspace: payload.workspace || null,
      runtimeSource: 'seo-runtime'
    }
    runtimeLiveActionsCache.set(cacheKey, { at: Date.now(), payload: runtimeResult })
    return JSON.parse(JSON.stringify(runtimeResult))
  } catch (error) {
    logThrottled(`runtime_live_actions_failed:${workspace?.id || workspace?.repoFullName || workspace?.label || 'default'}`, 15 * 60 * 1000, 'runtime_live_actions_failed', {
      workspace: workspace?.label || workspace?.id || workspace?.repoFullName || null,
      limit,
      error: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error)
    })
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function runNextApprovedCodeActionThroughRuntime() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(env.SEO_RUNTIME_CODE_RUN_TIMEOUT_MS || String(50 * 60 * 1000)))
  try {
    const response = await fetch(`${seoRuntimeUrl}/seo/actions/run-next`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'seo-agent-discord' })
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text }
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.detail || text || `runtime_code_http_${response.status}`)
    }
    if (payload?.ran || payload?.reason === 'already_running') {
      log('runtime_code_action_result', {
        ran: Boolean(payload.ran),
        status: payload.status || payload.reason || '',
        actionId: payload.action?.id || payload.running?.actionId || null
      })
    }
    return {
      ok: true,
      ran: Boolean(payload?.ran),
      running: payload?.reason === 'already_running',
      payload
    }
  } catch (error) {
    logThrottled('runtime_code_action_failed_fallback_to_worker', 15 * 60 * 1000, 'runtime_code_action_failed_fallback_to_worker', {
      error: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error)
    })
    return { ok: false, ran: false, error: error?.message || String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

async function postRuntimeCodeActionResult(runtimeRun) {
  const payload = runtimeRun?.payload || {}
  const action = payload.action || {}
  const workspace = payload.workspace || {}
  const targetChannelId = action.channelId || await channelForWorkspace(workspace).catch(() => null)
  if (!targetChannelId) return
  if (payload.status === 'completed') {
    const result = payload.result || {}
    const repoFullName = result.repoFullName || action.repoFullName || workspace.repoFullName || ''
    const commitUrl = result.commit ? githubCommitUrl(repoFullName, result.commit) : ''
    await markPostedActionHandled(action.id, targetChannelId, 'code_action_completed')
    const posted = await sendDiscordMessage([
      `Kodaction klar för ${workspace.label || action.repoFullName || 'workspace'}: ${action.title || action.id}`,
      `Action ID: \`${action.id}\``,
      result.commit ? `Commit: ${result.commit}` : '',
      commitUrl ? `GitHub: ${commitUrl}` : '',
      result.diffStat ? `Diff:\n\`\`\`\n${String(result.diffStat).slice(0, 1200)}\n\`\`\`` : '',
      '',
      'Om detta blev fel kan du trycka Backa så skapar jag en revert-commit.'
    ].filter(Boolean).join('\n'), targetChannelId, rollbackComponents(), { kind: 'code_result' })
    state.messageToAction = state.messageToAction || {}
    state.messageToAction[posted.id] = action.id
    saveState()
    return
  }
  const failure = payload.failure || classifyCodeActionFailure(new Error(payload.error || payload.status || 'runtime_code_action_failed'))
  await markPostedActionHandled(action.id, targetChannelId, 'code_action_failed')
  await sendDiscordMessage(formatCodeActionFailureMessage(workspace.label || action.repoFullName || 'workspace', action.title || action.id, new Error(payload.error || payload.status || 'runtime_code_action_failed'), failure), targetChannelId)
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
  return env.SEO_AGENT_PREFER_REPO_ONLY_ACTIONS === 'true' && Boolean(workspace?.repoFullName && String(workspace?.gscProperty || '').startsWith('sc-domain:'))
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
    '\nTolkning: om activeCards är högt har agenten många kandidater att klassificera eller köra; om unresolved incidents är högt är Platform API/GSC-data svag; om failed växer ska runner/repo/build fixas innan fler kodjobb körs.'
  ].filter(Boolean).join('\n').slice(0, 1900)
}

function shortActionId(id) {
  const text = String(id || '')
  if (text.length <= 80) return text
  return `${text.slice(0, 42)}...${text.slice(-28)}`
}

function formatStatusMessage(workspace, payload, targetChannelId = null) {
  const board = buildWorkspaceActionBoard(workspace, payload, targetChannelId)
  const next = board.nextRecommended
  const sample = (label, items) => items.length ? `${label}: ${items.slice(0, 3).map((item) => item.commit ? `${item.title} (${item.commit})` : item.title).join(' | ')}` : ''
  return [
    `SEO Agent status${workspace ? ` för ${workspace.label || workspace.id}` : ''}`,
    payload.error ? `Datavarning: ${payload.error}` : `Board: ${board.summary}. Live-actions: ${board.dataStatus.liveActionCount}.`,
    next ? `Nästa rekommenderade: ${next.title}${next.targetUrl ? ` (${next.targetUrl})` : ''}` : 'Nästa rekommenderade: inget säkert kort just nu.',
    next?.reason ? `Varför: ${String(next.reason).slice(0, 240)}` : '',
    sample('Körs/godkända', board.doing),
    sample('Klara', board.done),
    sample('Kandidater', board.waiting),
    sample('Blockerade', board.blocked),
    sample('Bortprioriterade', board.deprioritized),
    workspace ? `GSC: ${workspace.gscProperty || 'saknas'} · Repo: ${workspace.repoFullName || 'saknas'} · Branch: ${workspace.branch || 'main'}` : '',
  ].filter(Boolean).join('\n').slice(0, 1900)
}

function ensureAutonomousAgentState() {
  state.workspaceProfiles = state.workspaceProfiles || {}
  state.actionLedger = state.actionLedger || {}
  state.codexActionCardBriefCache = state.codexActionCardBriefCache || {}
  state.keywordMaps = state.keywordMaps || {}
  state.seoExperiments = state.seoExperiments || {}
  state.experimentOutcomes = state.experimentOutcomes || {}
  state.rankingReviews = state.rankingReviews || {}
  state.agentLessons = state.agentLessons || []
  state.guardedActions = state.guardedActions || {}
  state.repoCommitSync = state.repoCommitSync || {}
  migrateExistingStateToActionLedger()
}

async function runDailyRankingReviews(workspaces) {
  if (!automationEnabled) return
  const today = new Date().toISOString().slice(0, 10)
  state.rankingReviews = state.rankingReviews || {}
  for (const workspace of workspaces) {
    const targetChannelId = await channelForWorkspace(workspace)
    if (!targetChannelId) continue
    const key = workspaceProfileKey(workspace, targetChannelId)
    if (state.rankingReviews[key]?.date === today) continue
    const review = await buildRankingReview(workspace, targetChannelId).catch((error) => ({
      ok: false,
      error: error?.message || String(error)
    }))
    state.rankingReviews[key] = {
      date: today,
      at: new Date().toISOString(),
      ...review
    }
    if (review.ok && shouldNotifyRankingReview(review)) {
      await sendDiscordMessage(formatRankingReviewMessage(workspace, review), targetChannelId)
    }
  }
}

async function buildRankingReview(workspace, targetChannelId) {
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const keywordMap = ensureKeywordMap(workspace, targetChannelId)
  const payload = await fetchActionsForChat(workspace).catch((error) => ({ error: error?.message || String(error), actions: [] }))
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  const workspaceKey = workspaceProfileKey(workspace, targetChannelId)
  const experiments = Object.values(state.seoExperiments || {})
    .filter((item) => item.workspaceKey === workspaceKey)
    .sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))
  const outcomeReview = evaluateDueSeoExperiments({ workspace, targetChannelId, actions, experiments })
  const pendingFollowups = experiments.filter((item) => item.reviewAfter && item.reviewAfter <= new Date().toISOString().slice(0, 10) && !item.reviewedAt)
  const unmappedActions = actions
    .filter((action) => isCodeAction(action) && !isIndexingCheckAction(action))
    .filter((action) => !mapKeywordForAction(action, keywordMap))
    .slice(0, 5)
  const weakLiveQueue = actions.length === 0 || actions.every((action) => {
    const review = reviewActionForPosting(action, workspace, targetChannelId, payload.workspacePolicy || '')
    return review.score < 55
  })
  const staleKeywordTargets = keywordMap
    .filter((item) => item.priority !== 'low')
    .filter((item) => {
      const recentExperiment = experiments.find((experiment) => experiment.targetUrl === item.targetUrl || experiment.keyword === item.keyword)
      if (!recentExperiment) return true
      const completedAt = Date.parse(recentExperiment.completedAt || '')
      return completedAt && Date.now() - completedAt > 30 * 24 * 60 * 60 * 1000
    })
    .slice(0, 5)
  const next = selectRankingReviewNextStep({ workspace, profile, keywordMap, actions, experiments, staleKeywordTargets, weakLiveQueue, targetChannelId })
  return {
    ok: true,
    profileLabel: profile.label,
    keywordMapCount: keywordMap.length,
    liveActionCount: actions.length,
    experimentCount: experiments.length,
    pendingFollowups: pendingFollowups.slice(0, 5).map((item) => ({
      id: item.id,
      title: item.title,
      keyword: item.keyword,
      targetUrl: item.targetUrl,
      commit: item.commit,
      reviewAfter: item.reviewAfter
    })),
    outcomeReview,
    learningSummary: buildWorkspaceLearningSummary(workspaceKey),
    unmappedActionCount: unmappedActions.length,
    staleKeywordTargets,
    weakLiveQueue,
    next
  }
}

function selectRankingReviewNextStep({ workspace, profile, keywordMap, actions, experiments, staleKeywordTargets, weakLiveQueue, targetChannelId }) {
  const actionable = actions
    .filter((action) => isCodeAction(action) && !isIndexingCheckAction(action))
    .map((action) => ({ action, review: reviewActionForPosting(action, workspace, targetChannelId, '') }))
    .filter((item) => item.review.score >= 60)
    .sort((a, b) => b.review.score - a.review.score)[0]
  if (actionable) {
    return {
      type: 'live_action',
      title: actionable.action.title || actionable.action.id,
      actionId: actionable.action.id || '',
      targetUrl: actionable.action.targetUrl || actionable.action.url || '',
      keyword: actionable.action.keyword || '',
      reason: actionable.review.positives?.join('; ') || actionable.review.why || 'bästa live-action just nu'
    }
  }
  const gap = staleKeywordTargets[0] || keywordMap.find((item) => item.priority === 'high')
  if (gap && weakLiveQueue) {
    return {
      type: 'keyword_gap',
      title: `Förstärk ${gap.targetUrl} för "${gap.keyword}"`,
      targetUrl: gap.targetUrl,
      keyword: gap.keyword,
      reason: 'keyword-map saknar färskt experiment eller live-kön är svag'
    }
  }
  const followup = experiments.find((item) => item.reviewAfter && item.reviewAfter <= new Date().toISOString().slice(0, 10) && !item.reviewedAt)
  if (followup) {
    return {
      type: 'experiment_followup',
      title: `Följ upp experiment: ${followup.title}`,
      targetUrl: followup.targetUrl,
      keyword: followup.keyword,
      commit: followup.commit,
      reason: '14-dagars uppföljning är redo'
    }
  }
  return {
    type: 'monitor',
    title: 'Inget starkt nytt experiment just nu',
    reason: 'väntar på bättre live-data eller uppföljningsdatum'
  }
}

function shouldNotifyRankingReview(review) {
  if (!review?.ok) return false
  if (review.pendingFollowups?.length) return true
  if (review.weakLiveQueue && review.next?.type === 'keyword_gap') return true
  return false
}

function formatRankingReviewMessage(workspace, review) {
  const next = review.next || {}
  const outcomes = review.outcomeReview?.reviewed?.slice(0, 3) || []
  return [
    `Daglig ranking-review för ${workspace?.label || workspace?.id || 'workspace'}`,
    `Keyword-map: ${review.keywordMapCount} mål · Experiment: ${review.experimentCount} · Live-actions: ${review.liveActionCount}`,
    review.pendingFollowups?.length ? `Uppföljning redo: ${review.pendingFollowups.map((item) => `${item.keyword || item.title}${item.commit ? ` (${item.commit})` : ''}`).join(', ')}` : '',
    outcomes.length ? `Experiment-utvärdering: ${outcomes.map((item) => `${item.outcome}: ${item.keyword || item.targetUrl}`).join(' | ')}` : '',
    `Nästa SEO-experiment: ${next.title || 'inget säkert'}`,
    next.targetUrl ? `URL: ${next.targetUrl}` : '',
    next.keyword ? `Keyword: ${next.keyword}` : '',
    next.reason ? `Varför: ${next.reason}` : '',
    'Jag använder detta för att välja kodactions; GSC/API-kontroller rate-limtas och körs inte i loop.'
  ].filter(Boolean).join('\n').slice(0, 1900)
}

function evaluateDueSeoExperiments({ workspace, targetChannelId, actions, experiments }) {
  const today = new Date().toISOString().slice(0, 10)
  const dueExperiments = experiments.filter((item) => item?.reviewAfter && item.reviewAfter <= today && !item.reviewedAt)
  const reviewed = []
  for (const experiment of dueExperiments) {
    const matchingActions = actions.filter((action) => experimentMatchesAction(experiment, action))
    const unresolvedCodeActions = matchingActions.filter((action) => isCodeAction(action) && !isIndexingCheckAction(action))
    const gscOrIndexingActions = matchingActions.filter((action) => isIndexingCheckAction(action) || isGscAuthAction(action))
    let outcome = 'inconclusive'
    let confidence = 'low'
    let reason = 'No direct live action matched this experiment at follow-up time, but no Search Console performance snapshot is available.'
    let nextReviewAfter = addDaysIso(today, 14)
    if (unresolvedCodeActions.length) {
      outcome = 'needs_more_work'
      confidence = 'medium'
      reason = `SEO Monitor still has ${unresolvedCodeActions.length} matching content/code action(s), so the previous experiment did not fully clear the problem.`
      nextReviewAfter = addDaysIso(today, 7)
    } else if (gscOrIndexingActions.length) {
      outcome = 'inconclusive'
      confidence = 'medium'
      reason = 'Matching issue is operational/GSC-related, so content impact cannot be judged from live actions alone.'
      nextReviewAfter = addDaysIso(today, 7)
    } else {
      outcome = 'provisionally_improved'
      confidence = 'low'
      reason = 'No matching live action remains; treat this as a weak positive signal until GSC/query metrics confirm it.'
      nextReviewAfter = addDaysIso(today, 30)
    }
    const outcomeRecord = {
      experimentId: experiment.id,
      actionId: experiment.actionId || null,
      workspaceKey: experiment.workspaceKey,
      workspaceLabel: experiment.workspaceLabel || workspace?.label || workspace?.id || '',
      targetUrl: experiment.targetUrl || '',
      keyword: experiment.keyword || experiment.mappedKeyword || '',
      commit: experiment.commit || '',
      outcome,
      confidence,
      reason,
      matchingActionIds: matchingActions.map((action) => action.id).filter(Boolean).slice(0, 10),
      reviewedAt: new Date().toISOString(),
      nextReviewAfter
    }
    state.experimentOutcomes = state.experimentOutcomes || {}
    state.experimentOutcomes[experiment.id] = outcomeRecord
    state.seoExperiments[experiment.id] = {
      ...state.seoExperiments[experiment.id],
      reviewedAt: outcomeRecord.reviewedAt,
      outcome,
      outcomeConfidence: confidence,
      outcomeReason: reason,
      nextReviewAfter,
      reviewAfter: nextReviewAfter
    }
    rememberExperimentLesson(outcomeRecord)
    reviewed.push(outcomeRecord)
  }
  return {
    reviewed,
    dueCount: dueExperiments.length
  }
}

function experimentMatchesAction(experiment, action) {
  if (!experiment || !action) return false
  const experimentUrl = String(experiment.targetUrl || '').trim()
  const actionUrl = String(action.targetUrl || action.url || '').trim()
  if (experimentUrl && actionUrl && sameSeoUrl(experimentUrl, actionUrl)) return true
  const experimentKeyword = normalizeKeywordText(experiment.keyword || experiment.mappedKeyword || '')
  const actionKeyword = normalizeKeywordText(action.keyword || '')
  if (experimentKeyword && actionKeyword && (experimentKeyword === actionKeyword || actionKeyword.includes(experimentKeyword) || experimentKeyword.includes(actionKeyword))) return true
  const actionTextValue = normalizeKeywordText(`${action.title || ''} ${action.why || ''} ${action.recommendedAction || ''}`)
  return Boolean(experimentKeyword && actionTextValue.includes(experimentKeyword))
}

function rememberExperimentLesson(outcome) {
  const text = [
    `Experiment ${outcome.outcome} for ${outcome.workspaceLabel || outcome.workspaceKey}`,
    outcome.keyword ? `keyword "${outcome.keyword}"` : '',
    outcome.targetUrl ? `target ${outcome.targetUrl}` : '',
    outcome.commit ? `commit ${outcome.commit}` : '',
    `confidence ${outcome.confidence}: ${outcome.reason}`
  ].filter(Boolean).join(' ')
  rememberAgentLesson(text.slice(0, 700))
}

function buildWorkspaceLearningSummary(workspaceKey) {
  const outcomes = Object.values(state.experimentOutcomes || {})
    .filter((item) => item.workspaceKey === workspaceKey)
    .sort((a, b) => Date.parse(b.reviewedAt || 0) - Date.parse(a.reviewedAt || 0))
  const experiments = Object.values(state.seoExperiments || {})
    .filter((item) => item.workspaceKey === workspaceKey)
    .sort((a, b) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))
  return {
    recentCompleted: experiments.slice(0, 8).map((item) => ({
      title: item.title,
      targetUrl: item.targetUrl,
      keyword: item.keyword,
      commit: item.commit,
      completedAt: item.completedAt,
      reviewAfter: item.reviewAfter,
      outcome: item.outcome || null,
      outcomeConfidence: item.outcomeConfidence || null
    })),
    positiveSignals: outcomes.filter((item) => item.outcome === 'provisionally_improved').slice(0, 6),
    needsMoreWork: outcomes.filter((item) => item.outcome === 'needs_more_work').slice(0, 6),
    inconclusive: outcomes.filter((item) => item.outcome === 'inconclusive').slice(0, 4)
  }
}

function recentCodeResultsForWorkspace(workspace, targetChannelId = null) {
  const key = workspaceProfileKey(workspace, targetChannelId)
  const host = normalizeForMatch(workspaceHost(workspace) || workspace?.label || '')
  const repo = normalizeForMatch(workspace?.repoFullName || '')
  const ledgerByActionId = new Map(
    Object.values(state.actionLedger || {})
      .filter((item) => item?.actionId)
      .map((item) => [String(item.actionId), item])
  )
  return Object.entries(state.codeActionResults || {})
    .map(([actionId, result]) => {
      const ledger = ledgerByActionId.get(actionId) || {}
      return { actionId, result, ledger }
    })
    .filter(({ actionId, result, ledger }) => {
      if (String(ledger.workspaceKey || '') === key) return true
      const haystack = normalizeForMatch([
        actionId,
        result?.repoFullName,
        result?.result?.repoFullName,
        result?.result?.repoDir,
        ledger.workspaceKey,
        ledger.title,
        ledger.targetUrl
      ].filter(Boolean).join(' '))
      return Boolean((host && haystack.includes(host)) || (repo && haystack.includes(repo)))
    })
    .sort((a, b) => Date.parse(b.result.completedAt || b.result.failedAt || 0) - Date.parse(a.result.completedAt || a.result.failedAt || 0))
    .slice(0, 16)
    .map(({ actionId, result, ledger }) => ({
      actionId,
      status: result.status || ledger.status || '',
      title: ledger.title || result.result?.title || actionId,
      targetUrl: ledger.targetUrl || result.result?.targetUrl || '',
      keyword: ledger.keyword || result.result?.keyword || '',
      commit: result.result?.commit || ledger.commit || '',
      at: result.completedAt || result.failedAt || ledger.lastEventAt || '',
      failureCategory: result.failure?.category || '',
      summary: result.failure?.operatorSummary || result.error || ''
    }))
}

function addDaysIso(dateOrIso, days) {
  const date = new Date(`${String(dateOrIso).slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + Number(days || 0))
  return date.toISOString().slice(0, 10)
}

function cleanupStaleRuntimeState() {
  const now = Date.now()
  let changed = false
  if (state.codeActionRunning?.startedAt && Date.parse(state.codeActionRunning.startedAt) < processStartedAtMs) {
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
    if (!startedAt || now - startedAt <= stalePlatformIncidentMs) continue
    state.platformIncidents[key] = { ...incident, status: incident.status === 'resolved' ? 'resolved' : 'archived', archivedAt: new Date().toISOString() }
    rememberAgentLesson(`Archived stale platform incident ${key}`)
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
    autonomy: existing.autonomy === 'approve_before_code' ? 'autonomous_low_risk' : (existing.autonomy || defaults.autonomy || 'autonomous_low_risk'),
    goals: [...new Set([...(existing.goals || []), ...(defaults.goals || [])])].slice(0, 20),
    prefer: [...new Set([...(existing.prefer || []), ...(defaults.prefer || [])])].slice(0, 30),
    avoid: [...new Set([...(existing.avoid || []), ...(defaults.avoid || [])])].slice(0, 30),
    keywordMap: mergeKeywordMap(existing.keywordMap || state.keywordMaps?.[key] || [], defaults.keywordMap || []),
    updatedAt: existing.updatedAt || new Date().toISOString()
  }
  state.workspaceProfiles[key] = profile
  state.keywordMaps[key] = profile.keywordMap
  return profile
}

function ensureKeywordMap(workspace, targetChannelId = null) {
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const key = workspaceProfileKey(workspace, targetChannelId)
  const current = mergeKeywordMap(state.keywordMaps?.[key] || [], profile.keywordMap || [])
  state.keywordMaps[key] = current
  state.workspaceProfiles[key] = { ...profile, keywordMap: current }
  return current
}

function mergeKeywordMap(existing, defaults) {
  const byKey = new Map()
  for (const item of [...defaults, ...existing]) {
    if (!item || !item.keyword) continue
    const keyword = normalizeKeywordText(item.keyword)
    const targetUrl = String(item.targetUrl || item.url || '').trim()
    const key = `${keyword}:${targetUrl}`
    byKey.set(key, {
      keyword: item.keyword,
      targetUrl,
      intent: item.intent || 'commercial',
      priority: item.priority || 'medium',
      status: item.status || 'active',
      notes: item.notes || ''
    })
  }
  return [...byKey.values()].slice(0, 60)
}

function mapKeywordForAction(action, keywordMap) {
  const targetUrl = String(action.targetUrl || action.url || '').trim()
  const keyword = normalizeKeywordText(action.keyword || '')
  return keywordMap.find((item) => {
    const itemKeyword = normalizeKeywordText(item.keyword)
    return (targetUrl && item.targetUrl && sameSeoUrl(item.targetUrl, targetUrl))
      || (keyword && itemKeyword && (keyword === itemKeyword || keyword.includes(itemKeyword) || itemKeyword.includes(keyword)))
  }) || null
}

function sameSeoUrl(a, b) {
  return normalizeActionPath(a) === normalizeActionPath(b)
}

function recordSeoExperiment(action, workspace, targetChannelId, result, meta = {}) {
  ensureAutonomousAgentState()
  const workspaceKey = workspaceProfileKey(workspace, targetChannelId)
  const keywordMap = ensureKeywordMap(workspace, targetChannelId)
  const mapped = mapKeywordForAction(action, keywordMap)
  const completedAt = new Date().toISOString()
  const reviewDate = new Date(completedAt)
  reviewDate.setDate(reviewDate.getDate() + 14)
  const targetUrl = action.targetUrl || action.url || mapped?.targetUrl || ''
  const keyword = action.keyword || mapped?.keyword || ''
  const id = `${workspaceKey}:${normalizeActionPath(targetUrl) || normalizeKeywordCluster(keyword) || action.id || result?.commit || Date.now()}`.slice(0, 220)
  state.seoExperiments[id] = {
    ...(state.seoExperiments[id] || {}),
    id,
    actionId: action.id || null,
    title: action.title || action.id || '',
    workspaceKey,
    workspaceLabel: workspace?.label || workspace?.id || '',
    repoFullName: result?.repoFullName || workspace?.repoFullName || '',
    branch: result?.branch || workspace?.branch || 'main',
    targetUrl,
    keyword,
    mappedKeyword: mapped?.keyword || '',
    intent: mapped?.intent || '',
    priority: mapped?.priority || action.priority || '',
    commit: result?.commit || '',
    diffStat: result?.diffStat || '',
    completedAt,
    reviewAfter: reviewDate.toISOString().slice(0, 10),
    source: meta.source || 'code_action',
    baselineStatus: 'pending_gsc_snapshot'
  }
  rememberAgentLesson(`Started SEO experiment for ${workspace?.label || workspaceKey}: ${keyword || targetUrl || action.id}${result?.commit ? ` (${result.commit})` : ''}`)
}

function defaultWorkspaceProfile(workspace) {
  const label = String(workspace?.label || workspace?.id || '').toLowerCase()
  const inferred = inferWorkspaceProfile(workspace)
  if (label.includes('sebcastwall')) {
    return {
      label: workspace?.label || 'sebcastwall.se',
      siteType: 'ai_consultancy',
      audience: 'företag som vill köpa AI/kod/automation',
      goals: ['rank higher for AI consulting, AI agents, automation, app/web and AI education leads'],
      prefer: ['AI konsult', 'AI-agenter', 'AI-automation', 'kodning', 'app/web', 'interna verktyg', 'AI-utbildningar', 'workshops'],
      avoid: ['Fortnox-only', 'Visma-only', 'Business Central-only', 'Abicart/Klarna', 'generic integration-only', 'invoice/bookkeeping-only'],
      keywordMap: [
        { keyword: 'AI konsult företag', targetUrl: 'https://sebcastwall.se/', intent: 'commercial', priority: 'high' },
        { keyword: 'AI agenter företag', targetUrl: 'https://sebcastwall.se/tjanster/ai-agenter', intent: 'commercial', priority: 'high' },
        { keyword: 'AI automatisering företag', targetUrl: 'https://sebcastwall.se/tjanster/ai-automatisering', intent: 'commercial', priority: 'high' },
        { keyword: 'apputveckling företag', targetUrl: 'https://sebcastwall.se/tjanster/app-webbutveckling', intent: 'commercial', priority: 'high' },
        { keyword: 'AI utbildning företag', targetUrl: 'https://sebcastwall.se/tjanster/ai-utbildning', intent: 'commercial', priority: 'medium' },
        { keyword: 'AI workshop företag', targetUrl: 'https://sebcastwall.se/tjanster/ai-utbildning', intent: 'commercial', priority: 'high' },
        { keyword: 'AI tjänster företag', targetUrl: 'https://sebcastwall.se/tjanster', intent: 'commercial', priority: 'high' },
        { keyword: 'interna AI verktyg', targetUrl: 'https://sebcastwall.se/tjanster/interna-verktyg', intent: 'commercial', priority: 'high' },
        { keyword: 'AI interna verktyg', targetUrl: 'https://sebcastwall.se/tjanster/interna-verktyg', intent: 'commercial', priority: 'medium' },
        { keyword: 'ChatGPT för företag', targetUrl: 'https://sebcastwall.se/artiklar/chatgpt-for-foretag-kanslig-data', intent: 'informational_to_commercial', priority: 'medium' },
        { keyword: 'Google AI Studio företag', targetUrl: 'https://sebcastwall.se/artiklar/google-ai-studio', intent: 'informational_to_commercial', priority: 'medium' }
      ],
      autonomy: 'autonomous_low_risk'
    }
  }
  if (label.includes('natverkskollen')) {
    return {
      label: workspace?.label || 'natverkskollen.se',
      siteType: 'event_directory',
      audience: 'personer och företag som letar events/nätverk',
      goals: ['rank higher for startup events, networking and evergreen event landing pages'],
      prefer: ['startup events', 'nätverkande', 'entreprenörer', 'city pages', 'event category pages'],
      avoid: ['agency consulting', 'software integration', 'unrelated AI consultancy'],
      keywordMap: [
        { keyword: 'startup events', targetUrl: 'https://natverkskollen.se/evenemang/startup-events', intent: 'event_discovery', priority: 'high' },
        { keyword: 'nätverksevent', targetUrl: 'https://natverkskollen.se/evenemang', intent: 'event_discovery', priority: 'high' },
        { keyword: 'entreprenör event', targetUrl: 'https://natverkskollen.se/evenemang/entreprenor', intent: 'event_discovery', priority: 'medium' }
      ],
      autonomy: 'autonomous_low_risk'
    }
  }
  if (label.includes('parkeringspolaren')) {
    return {
      label: workspace?.label || 'parkeringspolaren.se',
      siteType: 'parking_service',
      audience: 'personer som söker parkering och vill boka/konvertera',
      goals: ['rank higher for parking intent and conversion landing pages'],
      prefer: ['parkering', 'flygplatsparkering', 'långtidsparkering', 'lokal intent', 'indexering', 'conversion'],
      avoid: ['unrelated software/AI consultancy'],
      keywordMap: [
        { keyword: 'flygplatsparkering', targetUrl: 'https://parkeringspolaren.se/', intent: 'commercial', priority: 'high' },
        { keyword: 'långtidsparkering', targetUrl: 'https://parkeringspolaren.se/', intent: 'commercial', priority: 'high' },
        { keyword: 'billig parkering', targetUrl: 'https://parkeringspolaren.se/', intent: 'commercial', priority: 'medium' }
      ],
      autonomy: 'autonomous_low_risk'
    }
  }
  if (inferred.siteType !== 'generic') return inferred
  return {
    label: workspace?.label || workspace?.id || 'workspace',
    siteType: 'generic',
    audience: 'relevanta sökare',
      goals: ['rank higher on relevant valuable search demand'],
      prefer: [],
      avoid: [],
      keywordMap: [],
      autonomy: 'autonomous_low_risk'
    }
  }

function inferWorkspaceProfile(workspace) {
  const signal = [
    workspace?.label,
    workspace?.id,
    workspace?.gscProperty,
    workspace?.repoFullName,
    workspace?.siteUrl
  ].filter(Boolean).join(' ').toLowerCase()
  if (/\b(vag|väg|road|route|trafik|traffic|weather|väder|bilresa|driving)\b/.test(signal)) {
    return {
      label: workspace?.label || 'road/weather workspace',
      siteType: 'road_weather_utility',
      audience: 'bilister och resenärer som planerar eller följer en bilresa',
      goals: ['rank higher for road weather, route weather, traffic and road condition searches'],
      prefer: ['väder längs vägen', 'vägväder', 'trafikläge', 'vägförhållanden', 'ruttplanering', 'bilresa', 'halka', 'regn', 'vind', 'road conditions'],
      avoid: ['SMB', 'B2B', 'consulting', 'SaaS', 'agency', 'business workflow', 'CRM', 'invoice'],
      keywordMap: [
        { keyword: 'väder längs vägen', targetUrl: 'https://vagkollen.se/', intent: 'utility', priority: 'high' },
        { keyword: 'vägväder', targetUrl: 'https://vagkollen.se/', intent: 'utility', priority: 'high' },
        { keyword: 'trafikläge', targetUrl: 'https://vagkollen.se/', intent: 'utility', priority: 'medium' },
        { keyword: 'vägförhållanden', targetUrl: 'https://vagkollen.se/', intent: 'utility', priority: 'medium' }
      ],
      autonomy: 'autonomous_low_risk'
    }
  }
  if (/\b(event|events|nätverk|network|startup|meetup)\b/.test(signal)) {
    return {
      label: workspace?.label || 'event workspace',
      siteType: 'event_directory',
      audience: 'personer som letar events, nätverk och sammanhang',
      goals: ['rank higher for event discovery and event landing page searches'],
      prefer: ['events', 'startup events', 'nätverkande', 'stadssidor', 'eventkategori', 'kalender'],
      avoid: ['software consulting', 'integration-only', 'generic SaaS'],
      keywordMap: [
        { keyword: 'startup events', targetUrl: 'https://natverkskollen.se/evenemang/startup-events', intent: 'event_discovery', priority: 'high' },
        { keyword: 'nätverksevent', targetUrl: 'https://natverkskollen.se/evenemang', intent: 'event_discovery', priority: 'high' }
      ],
      autonomy: 'autonomous_low_risk'
    }
  }
  if (/\b(parking|parkering|airport|flygplats|garage)\b/.test(signal)) {
    return {
      label: workspace?.label || 'parking workspace',
      siteType: 'parking_service',
      audience: 'personer som vill hitta och boka parkering',
      goals: ['rank higher for parking searches and conversion landing pages'],
      prefer: ['parkering', 'flygplatsparkering', 'långtidsparkering', 'pris', 'bokning', 'lokal intent'],
      avoid: ['software consulting', 'generic AI', 'B2B workflow'],
      keywordMap: [
        { keyword: 'parkering', targetUrl: workspace?.siteUrl || '', intent: 'commercial', priority: 'high' },
        { keyword: 'långtidsparkering', targetUrl: workspace?.siteUrl || '', intent: 'commercial', priority: 'medium' }
      ],
      autonomy: 'autonomous_low_risk'
    }
  }
  if (/\b(ai|automation|app|web|konsult|consult|agent)\b/.test(signal)) {
    return {
      label: workspace?.label || 'AI/service workspace',
      siteType: 'ai_consultancy',
      audience: 'företag som vill köpa AI, kod eller automation',
      goals: ['rank higher for AI, automation and development service demand'],
      prefer: ['AI', 'automation', 'app/web', 'kodning', 'konsult', 'utbildning'],
      avoid: ['consumer travel', 'parking', 'unrelated event discovery'],
      keywordMap: [
        { keyword: 'AI konsult', targetUrl: workspace?.siteUrl || '', intent: 'commercial', priority: 'high' },
        { keyword: 'AI automatisering', targetUrl: workspace?.siteUrl || '', intent: 'commercial', priority: 'medium' }
      ],
      autonomy: 'autonomous_low_risk'
    }
  }
  return {
    label: workspace?.label || workspace?.id || 'workspace',
    siteType: 'generic',
    audience: 'relevanta sökare',
    goals: ['rank higher on relevant valuable search demand'],
    prefer: [],
    avoid: [],
    keywordMap: [],
    autonomy: 'autonomous_low_risk'
  }
}

function shouldPostActionCard(action, workspace, targetChannelId) {
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const text = actionText(action)
  const kind = actionKindForLearning(action)
  const targetUrl = String(action.targetUrl || action.url || '').trim()
  const cluster = actionLearningKey(action, workspace, targetChannelId)
  const ledger = state.actionLedger?.[cluster]
  if (isGscAuthAction(action)) return { ok: false, reason: 'gsc_auth_status_not_seo_work' }
  if (isIndexingCheckAction(action)) return { ok: false, reason: 'indexing_check_is_internal' }
  if (isKeywordPlanAction(action)) return { ok: false, reason: 'keyword_plan_is_strategy_not_action_card' }
  if (isCodeAction(action) && !targetUrl && kind !== 'new-page') return { ok: false, reason: 'missing_target_url' }
  if (isCodeAction(action) && isLegalOrPolicyRoute(targetUrl)) return { ok: false, reason: 'legal_or_policy_route_needs_explicit_request' }
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

function isLegalOrPolicyRoute(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return false
  let pathname = text
  try {
    pathname = new URL(text).pathname.toLowerCase()
  } catch {}
  const compact = pathname.replace(/\/+$/, '') || '/'
  return /(?:^|\/)(terms|privacy|integritet|cookie|cookies|legal|terms-of-service|tos|anvandarvillkor|användarvillkor|villkor|dataskydd|gdpr)(?:\/|$)/i.test(compact)
}

function isKeywordPlanAction(action) {
  const text = actionText(action)
  return /keyword-plan|keywordmap|keyword-map|target-pages|target-sidor|lagg-in-foreslagen-keyword-plan|lagg-in-en-forsta-keyword-plan/.test(text)
}

function reviewActionForPosting(action, workspace, targetChannelId, workspacePolicy = '') {
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const text = actionText(action)
  const kind = actionKindForLearning(action)
  const ledgerKey = actionLearningKey(action, workspace, targetChannelId)
  const ledger = state.actionLedger?.[ledgerKey]
  const targetUrl = String(action.targetUrl || action.url || '').trim()
  const keyword = String(action.keyword || '').trim()
  let score = 45
  const positives = []
  const negatives = []

  if (targetUrl) {
    score += 15
    positives.push('har tydlig target-URL')
  } else if (kind === 'new-page') {
    score += 8
    positives.push('är en ny sida/landningssida')
  } else {
    score -= 18
    negatives.push('saknar tydlig target-URL')
  }

  const preferredHits = (profile.prefer || []).filter((term) => text.includes(normalizeForMatch(term)))
  const avoidedHits = (profile.avoid || []).filter((term) => text.includes(normalizeForMatch(term)))
  if (preferredHits.length) {
    score += Math.min(30, preferredHits.length * 10)
    positives.push(`matchar workspace-mål: ${preferredHits.slice(0, 3).join(', ')}`)
  }
  if (avoidedHits.length && !preferredHits.length) {
    score -= 40
    negatives.push(`drar mot lågprioriterat spår: ${avoidedHits.slice(0, 3).join(', ')}`)
  }

  if (isCodeAction(action)) {
    score += 15
    positives.push('kan bli en kod/commit-action')
  } else if (isIndexingCheckAction(action)) {
    score += 2
    negatives.push('är kontrollarbete, inte direkt sidförbättring')
  }

  if (kind === 'content' || kind === 'new-page') score += 12
  if (kind === 'internal-links') score += 5
  if (kind === 'indexing') score -= 5

  if (keyword) {
    const metrics = action.keywordMetrics && typeof action.keywordMetrics === 'object' ? action.keywordMetrics : null
    const volume = Number(metrics?.avgMonthlySearches || 0)
    if (volume > 0) {
      score += Math.min(20, Math.ceil(volume / 50))
      positives.push(`har sökvolym (${volume}/mån)`)
    } else if (/keyword|serp-gap|täck keyword|tack keyword/i.test(String(action.title || ''))) {
      score -= 12
      negatives.push('keyword saknar verifierad volym')
    }
  }

  if (ledger?.status === 'completed' && !isLedgerRecheckDue(ledger)) {
    score -= 80
    negatives.push('liknande action är redan genomförd')
  }
  if (isNatverkskollenWorkspace(workspace, profile) && targetsLegacyNatverkskollenEventsAlias(action)) {
    score -= 90
    negatives.push('använder /events-alias; canonical ska vara /evenemang')
  }
  if (ledger?.status === 'deprioritized' && !isLedgerRecheckDue(ledger)) {
    score -= 45
    negatives.push('du har nyligen prioriterat bort liknande action')
  }
  if (ledger?.status === 'ignored' && !isLedgerRecheckDue(ledger)) {
    score -= 55
    negatives.push('du har nyligen skippat liknande action')
  }
  if (Number(ledger?.guardedCount || 0) >= 2 && !isLedgerRecheckDue(ledger)) {
    score -= 35
    negatives.push('har redan stoppats av agentens guard flera gånger')
  }

  const title = String(action.title || '')
  if (title.length > 120) {
    score -= 8
    negatives.push('rubriken är onödigt lång')
  }
  if (!action.why && !action.recommendedAction) {
    score -= 20
    negatives.push('saknar tydlig motivering')
  }

  const recommendation = score >= 78 ? 'Approve' : score >= 55 ? 'Review' : score >= 40 ? 'Deprioritize' : 'Skip'
  const ok = score >= 45 && recommendation !== 'Skip'
  const reason = ok ? 'agent_review_passed' : `agent_review_rejected_${recommendation.toLowerCase()}`
  return {
    ok,
    score,
    recommendation,
    reason,
    kind,
    positives: positives.slice(0, 4),
    negatives: negatives.slice(0, 4),
    why: action.why || priorityReasonFromReview(positives, negatives, workspacePolicy),
    expectedWork: expectedWorkForAction(action, kind),
    risk: riskForAction(action, kind, score),
    decisionPrompt: decisionPromptForReview(recommendation)
  }
}

function isNatverkskollenWorkspace(workspace, profile) {
  return [workspace?.label, workspace?.id, workspace?.gscProperty, workspace?.repoFullName, profile?.label]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes('natverkskollen'))
}

function targetsLegacyNatverkskollenEventsAlias(action) {
  const url = String(action.targetUrl || action.url || '').trim()
  const text = [action.title, action.keyword, action.why, action.recommendedAction].filter(Boolean).join(' ')
  return /(^|\/)(events)(\/|$)/i.test(url.replace(/^https?:\/\/[^/]+/i, '')) || /\/events\b/i.test(text)
}

function priorityReasonFromReview(positives, negatives, workspacePolicy) {
  if (positives.length) return positives.join('; ')
  if (workspacePolicy) return `matchar workspace-policy: ${String(workspacePolicy).slice(0, 160)}`
  if (negatives.length) return `svagare kort: ${negatives.join('; ')}`
  return 'ligger högt i SEO-kön och passerar agentens relevanskontroll'
}

function expectedWorkForAction(action, kind) {
  if (isIndexingCheckAction(action)) return 'öppnar GSC/URL Inspection eller markerar kontrollen som hanterad'
  if (kind === 'new-page') return 'skapar eller produktifierar en landningssida, bygger, committar och postar GitHub-länk'
  if (kind === 'internal-links') return 'lägger relevanta interna länkar/CTA, bygger, committar och postar GitHub-länk'
  if (kind === 'content') return 'uppdaterar copy, rubriker, metadata/CTA vid behov, bygger, committar och postar GitHub-länk'
  return 'gör minsta säkra repoändring, bygger, committar och postar GitHub-länk'
}

function riskForAction(action, kind, score) {
  if (isIndexingCheckAction(action)) return 'låg, ingen kodändring'
  if (kind === 'new-page') return 'medium, ny sida och navigering kan påverka struktur'
  if (score < 60) return 'medium, actionen behöver mänsklig bedömning innan kod'
  return 'låg, främst content eller internlänkar'
}

function decisionPromptForReview(recommendation) {
  if (recommendation === 'Approve') return 'Jag rekommenderar Approve.'
  if (recommendation === 'Review') return 'Jag tycker den är rimlig, men vill att du bekräftar innan jag kodar.'
  if (recommendation === 'Deprioritize') return 'Jag skulle normalt vänta med den här om du inte tycker den är viktig.'
  return 'Jag rekommenderar Skip.'
}

function rememberGuardedAction(action, workspace, targetChannelId, reason) {
  recordActionLedger(action, workspace, targetChannelId, 'guarded', { reason })
  const key = actionLearningKey(action, workspace, targetChannelId)
  state.guardedActions[key] = { actionId: action.id || null, title: action.title || '', reason, at: new Date().toISOString() }
  rememberAgentLesson(`Guarded ${key}: ${reason}`)
}

function rememberCodexRejectedAction(action, workspace, targetChannelId, codexBrief, source = 'codex_guard') {
  const recommendation = String(codexBrief?.recommendation || '').toLowerCase()
  const decision = String(codexBrief?.decision || '').toLowerCase()
  const reason = `codex:${codexBrief?.recommendation || codexBrief?.decision || 'unavailable'}:${codexBrief?.reason || codexBrief?.why || source}`
  const event = recommendation === 'deprioritize' ? 'deprioritized' : recommendation === 'skip' || decision === 'block' ? 'ignored' : 'guarded'
  const recheckDays = event === 'guarded' ? 1 : 7
  recordActionLedger(action, workspace, targetChannelId, event, {
    reason: reason.slice(0, 360),
    source,
    recheckAfter: isoDatePlusDays(recheckDays)
  })
  if (event === 'guarded') {
    const key = actionLearningKey(action, workspace, targetChannelId)
    state.guardedActions[key] = { actionId: action.id || null, title: action.title || '', reason, at: new Date().toISOString() }
  }
  rememberAgentLesson(`Codex stopped ${actionLearningKey(action, workspace, targetChannelId)}: ${reason.slice(0, 180)}`)
}

function isoDatePlusDays(days) {
  return new Date(Date.now() + Number(days || 0) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
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
  const explicitlyNoNewPage = /skapa-ingen-ny-sida|skapa-inte-ny-sida|ingen-ny-sida|befintlig-sida/.test(text)
  if (!explicitlyNoNewPage && /ny-sida|new-page|skapa-ny.*sida|ny.*landningssida/.test(text)) return 'new-page'
  if (/title|meta|h1|h2|intro|faq|copy|content|readiness|serp|keyword|ranking/.test(text)) return 'content'
  if (/landningssida/.test(text)) return 'content'
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
  const keywordMap = ensureKeywordMap(workspace, targetChannelId).slice(0, 8)
  return [
    `Workspace-mål: ${profile.label}`,
    `Mål: ${(profile.goals || []).join('; ') || 'ranka högre på relevant efterfrågan'}`,
    `Prioritera: ${(profile.prefer || []).join(', ') || 'saknas'}`,
    `Undvik: ${(profile.avoid || []).join(', ') || 'saknas'}`,
    keywordMap.length ? `Keyword-map:\n${keywordMap.map((item) => `- ${item.keyword} -> ${item.targetUrl || 'URL saknas'} (${item.priority})`).join('\n')}` : 'Keyword-map: saknas',
    `Autonomi: ${profile.autonomy || 'autonomous_low_risk'}`
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

async function buildActionCardMessage(action, workspacePolicy, workspace, review = null, targetChannelId = null) {
  const codexBrief = await runCodexActionCardBrief({ action, workspace, workspacePolicy, review, targetChannelId }).catch((error) => {
    log('codex_action_card_brief_failed', { actionId: action?.id || null, workspace: workspace?.label || workspace?.id || null, error: error?.message || String(error) })
    return null
  })
  if (codexBrief?.decision === 'block') {
    rememberCodexRejectedAction(action, workspace, targetChannelId, codexBrief, 'posted_action_card_brief')
    log('codex_action_card_blocked', {
      actionId: action?.id || null,
      workspace: workspace?.label || workspace?.id || null,
      reason: codexBrief.reason || codexBrief.why || 'unclear_action'
    })
    return null
  }
  return formatActionMessage(action, workspacePolicy, workspace, {
    ...review,
    ...(codexBrief?.decision ? { codexDecision: codexBrief.decision } : {}),
    ...(codexBrief?.reason ? { codexReason: codexBrief.reason } : {}),
    ...(codexBrief?.title ? { actionTitle: codexBrief.title } : {}),
    ...(codexBrief?.doThis ? { concreteAction: codexBrief.doThis } : {}),
    ...(codexBrief?.why ? { why: codexBrief.why } : {}),
    ...(codexBrief?.risk ? { risk: codexBrief.risk } : {}),
    ...(codexBrief?.expectedWork ? { expectedWork: codexBrief.expectedWork } : {}),
    ...(codexBrief?.recommendation ? { recommendation: codexBrief.recommendation } : {})
  })
}

async function runCodexActionCardBrief({ action, workspace, workspacePolicy, review, targetChannelId }) {
  if (!codexChatEnabled) return null
  const profile = ensureWorkspaceProfile(workspace, targetChannelId)
  const cacheKey = actionCardBriefCacheKey(action, workspace, targetChannelId, review)
  const cached = getCachedActionCardBrief(cacheKey)
  if (cached.found) {
    logThrottled(`codex_action_card_brief_cache_hit:${cacheKey}`, 30 * 60 * 1000, 'codex_action_card_brief_cache_hit', {
      actionId: action?.id || null,
      workspace: workspace?.label || workspace?.id || null,
      decision: cached.result?.decision || null,
      recommendation: cached.result?.recommendation || null
    })
    return cached.result
  }
  const promptPath = join(stateDir, 'codex-action-card-brief.md')
  const context = {
    workspace: workspace ? {
      id: workspace.id,
      label: workspace.label,
      gscProperty: workspace.gscProperty,
      repoFullName: workspace.repoFullName,
      branch: workspace.branch || 'main'
    } : null,
    inferredProfile: profile,
    workspacePolicy,
    deterministicReview: review,
    action: compactActionForChat(action),
    rawAction: {
      id: action?.id,
      title: action?.title,
      targetUrl: action?.targetUrl || action?.url || null,
      keyword: action?.keyword || null,
      keywordMetricsStatus: action?.keywordMetricsStatus || null,
      keywordMetrics: action?.keywordMetrics || null,
      keywordMetricsError: action?.keywordMetricsError || null,
      evidenceSource: action?.evidenceSource || null,
      evidenceBatchId: action?.evidenceBatchId || null,
      evidenceRunAt: action?.evidenceRunAt || null,
      evidenceNote: action?.evidenceNote || null,
      category: action?.category || null,
      priority: action?.priority || null,
      why: action?.why || null,
      recommendedAction: action?.recommendedAction || null,
      evidence: Array.isArray(action?.evidence) ? action.evidence.slice(0, 8) : []
    }
  }
  const prompt = [
    'Du är SEO Agentens Codex-hjärna innan ett Discord-actionkort postas.',
    'Ditt jobb är att förstå vilken sorts sajt/workspace detta är och formulera en konkret, workspace-korrekt åtgärd.',
    'Var smart: om det är en konsumenttjänst ska du inte använda B2B/SMB/konsultspråk. Om det är en katalog/tjänst/produkt ska åtgärden passa den typen.',
    'Om actionen verkar fel workspace, generisk, repetitiv eller otydlig: decision=block eller rewrite med tydlig förklaring.',
    'Returnera ENDAST JSON:',
    '{"decision":"allow|rewrite|block","title":"kort konkret svensk titel","doThis":"en konkret mening om exakt vad som ska göras","why":"kort varför detta är rätt för just detta workspace","risk":"låg|medium + kort orsak","expectedWork":"vad agenten gör automatiskt om det är låg risk, annars vad den behöver fråga om","recommendation":"Approve|Review|Deprioritize|Skip","reason":"kort intern orsak"}',
    '',
    'Regler:',
    '- Skriv på svenska.',
    '- Max 220 tecken i title, max 420 tecken i doThis.',
    '- Nämn rätt domän/tjänsttyp utifrån context.',
    '- Var ärlig om evidens: om evidenceSource är workspace_goal_backlog eller Keyword Planner saknar metrics, säg inte att åtgärden bygger på färsk GSC/Keyword Planner-data.',
    '- Om evidenceSource är fresh_seo_run_plus_workspace_backlog: säg att åtgärden är validerad mot färsk SEO Monitor-batch men inte nödvändigtvis en exakt färsk GSC-query.',
    '- Om Keyword Planner har volym/CPC/competition, använd det konkret i why/reason.',
    '- Ingen rå JSON/tool-output i fälten.',
    '- Låtsas inte att kod redan körts.',
    '',
    'AGENT SPEC:',
    readAgentSpecs(3500),
    '',
    'CONTEXT JSON:',
    JSON.stringify(context, null, 2)
  ].join('\n')
  writeFileSync(promptPath, prompt)
  const result = await execCodexTracked({
    agent: 'seo-agent',
    purpose: 'action_card_brief',
    workspace: workspace?.label || workspace?.id || null,
    command: `${codexCli} exec --json --cd /home/deploy/seo-agent-discord --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`,
    timeout: 3 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024
  })
  const brief = normalizeActionCardBrief(extractCodexExecText(result.stdout || ''))
  setCachedActionCardBrief(cacheKey, brief, action, workspace)
  return brief
}

function actionCardBriefCacheKey(action, workspace, targetChannelId, review = null) {
  const payload = JSON.stringify({
    workspaceKey: workspaceProfileKey(workspace, targetChannelId),
    actionId: action?.id || '',
    title: action?.title || '',
    targetUrl: action?.targetUrl || action?.url || '',
    keyword: action?.keyword || '',
    category: action?.category || '',
    why: action?.why || '',
    recommendedAction: action?.recommendedAction || '',
    evidenceSource: action?.evidenceSource || '',
    reviewRecommendation: review?.recommendation || '',
    reviewScore: review?.score || ''
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

function getCachedActionCardBrief(cacheKey) {
  ensureAutonomousAgentState()
  const entry = state.codexActionCardBriefCache?.[cacheKey]
  if (!entry) return { found: false, result: null }
  if (Number(entry.expiresAtMs || 0) <= Date.now()) {
    delete state.codexActionCardBriefCache[cacheKey]
    return { found: false, result: null }
  }
  return { found: true, result: entry.result || null }
}

function setCachedActionCardBrief(cacheKey, brief, action, workspace) {
  ensureAutonomousAgentState()
  const decision = String(brief?.decision || '').toLowerCase()
  const recommendation = String(brief?.recommendation || '').toLowerCase()
  const blocked = !brief || decision === 'block' || recommendation === 'skip' || recommendation === 'deprioritize'
  const ttlMs = blocked ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000
  state.codexActionCardBriefCache[cacheKey] = {
    result: brief || null,
    actionId: action?.id || null,
    workspace: workspace?.label || workspace?.id || null,
    cachedAt: new Date().toISOString(),
    expiresAtMs: Date.now() + ttlMs
  }
  pruneActionCardBriefCache()
}

function pruneActionCardBriefCache() {
  const entries = Object.entries(state.codexActionCardBriefCache || {})
    .filter(([, item]) => Number(item?.expiresAtMs || 0) > Date.now())
    .sort((a, b) => Number(b[1]?.expiresAtMs || 0) - Number(a[1]?.expiresAtMs || 0))
    .slice(0, 300)
  state.codexActionCardBriefCache = Object.fromEntries(entries)
}

function normalizeActionCardBrief(text) {
  const raw = String(text || '').trim()
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw
  let parsed = null
  try { parsed = JSON.parse(jsonText) } catch { return null }
  const decision = ['allow', 'rewrite', 'block'].includes(parsed.decision) ? parsed.decision : 'allow'
  const recommendation = ['Approve', 'Review', 'Deprioritize', 'Skip'].includes(parsed.recommendation) ? parsed.recommendation : ''
  return {
    decision,
    title: typeof parsed.title === 'string' ? parsed.title.slice(0, 220) : '',
    doThis: typeof parsed.doThis === 'string' ? parsed.doThis.slice(0, 520) : '',
    why: typeof parsed.why === 'string' ? parsed.why.slice(0, 420) : '',
    risk: typeof parsed.risk === 'string' ? parsed.risk.slice(0, 180) : '',
    expectedWork: typeof parsed.expectedWork === 'string' ? parsed.expectedWork.slice(0, 220) : '',
    recommendation,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : ''
  }
}

function formatActionMessage(action, workspacePolicy, workspace, review = null) {
  if (isGscAuthAction(action)) return formatGscAuthMessage(action, workspacePolicy, workspace)
  const showKeywordAsSearchTerm = shouldUseKeywordPlannerMetrics(action)
  const label = workspace?.label || action.workspaceSlug || action.projectSlug || 'workspace'
  const title = review?.actionTitle || humanActionTitle(action)
  const concreteAction = review?.concreteAction || humanConcreteAction(action, workspace)
  const why = review?.why || action.why || 'Passerar SEO-agentens relevanskontroll.'
  const expectedWork = review?.expectedWork || (isCodeAction(action) ? 'gör en repoändring, bygger, committar och postar GitHub-länk' : 'hanterar kontrollen och markerar nästa steg')
  const risk = review?.risk || 'okänd'
  const recommendation = review?.recommendation || (isCodeAction(action) ? 'Review' : 'Review')
  const score = Number.isFinite(Number(review?.score)) ? ` · score ${Math.round(Number(review.score))}` : ''
  const codexDecision = review?.codexDecision ? `Codex-bedömning: ${review.codexDecision}${review.codexReason ? ` (${String(review.codexReason).slice(0, 140)})` : ''}` : ''
  const lines = [
    `Nästa SEO-kandidat för ${label}`,
    '',
    `Jag rekommenderar: ${recommendation}${score}`,
    codexDecision,
    `Kort: ${title}`,
    action.targetUrl ? `URL: ${action.targetUrl}` : '',
    action.keyword ? `${showKeywordAsSearchTerm ? 'Keyword' : 'Focus'}: ${action.keyword}` : '',
    showKeywordAsSearchTerm ? formatKeywordMetricsLine(action) : '',
    '',
    `Gör detta: ${concreteAction}`,
    `Varför: ${String(why).slice(0, 360)}`,
    `Vad agenten gör: ${expectedWork}.`,
    `Risk: ${risk}.`,
    action.recommendedAction ? `Detalj: ${String(action.recommendedAction).slice(0, 420)}` : '',
    review?.negatives?.length ? `Notis: ${review.negatives.join('; ')}` : '',
    '',
    `ID: \`${action.id}\``,
    isCodeAction(action)
      ? `Välj med knapparna, eller svara i vanlig svenska om jag ska köra den, hoppa över den, vänta med den eller förklara mer.`
      : `Det här är en GSC/browser-check, inte en kodaction. Tryck Open in GSC för att öppna Search Console-fönstret, eller skriv i chatten om den är hanterad, kan vänta eller behöver förklaras.`
  ]
  return lines.filter(Boolean).join('\n').slice(0, 1900)
}

function humanActionTitle(action) {
  const title = String(action?.title || '').trim()
  const targetUrl = String(action?.targetUrl || action?.url || '').trim()
  if (/^ai search readiness:\s*\/?$/i.test(title)) {
    return targetUrl ? `Bygg ut startsidan för AI Search (${targetUrl})` : 'Bygg ut startsidan för AI Search'
  }
  return title || 'SEO-action'
}

function humanConcreteAction(action, workspace = null) {
  const recommended = String(action?.recommendedAction || '').trim()
  const title = String(action?.title || '').trim()
  const targetUrl = String(action?.targetUrl || action?.url || '').trim()
  if (/^ai search readiness:\s*\/?$/i.test(title)) {
    const profile = defaultWorkspaceProfile(workspace || action)
    const specific = aiSearchReadinessActionForProfile(profile, targetUrl)
    if (specific) return specific
    return [
      targetUrl ? `Uppdatera startsidan ${targetUrl}.` : 'Uppdatera startsidan.',
      'Lägg in mer konkret hjälpsamt innehåll: exempel/scenario, tydliga use cases, fallgropar, nästa steg och interna länkar.',
      'Målet är att sidan ska kännas som en verklig produkt/tjänst för användare och AI Search, inte generisk text.'
    ].join(' ')
  }
  if (recommended) return recommended.slice(0, 520)
  if (targetUrl) return `Gör en fokuserad SEO-förbättring på ${targetUrl} och verifiera med build.`
  return 'Gör den minsta konkreta SEO-förbättringen som matchar kortet och verifiera med build.'
}

function aiSearchReadinessActionForProfile(profile, targetUrl) {
  const intro = targetUrl ? `Uppdatera startsidan ${targetUrl}.` : 'Uppdatera startsidan.'
  if (profile?.siteType === 'road_weather_utility') {
    return [
      intro,
      'Gör den tydligare som en väg- och vädertjänst: konkreta rutt-/rese-scenarion, vägväder, trafikläge, halka/regn/vind och när användaren bör kolla tjänsten före eller under en resa.',
      'Målet är att sidan ska förklara den faktiska nyttan för bilresor i Sverige, inte låta som en generisk B2B- eller konsulttjänst.'
    ].join(' ')
  }
  if (profile?.siteType === 'parking_service') {
    return [
      intro,
      'Gör den tydligare som en parkeringstjänst: konkreta sök- och bokningsscenarion, pris/avstånd/tidsbesparing, flygplats- eller lokal kontext, trygghet och vad användaren gör härnäst.',
      'Målet är att sidan ska hjälpa en person att välja parkering, inte beskriva en generisk mjukvaru- eller konsulttjänst.'
    ].join(' ')
  }
  if (profile?.siteType === 'event_directory') {
    return [
      intro,
      'Gör den tydligare som en event-/nätverkstjänst: konkreta eventtyper, stad eller målgrupp, exempel på när sidan används, hur man hittar rätt event och interna länkar till relevanta kluster.',
      'Målet är att sidan ska hjälpa någon att hitta rätt sammanhang, inte låta som en generisk SaaS- eller konsultsida.'
    ].join(' ')
  }
  if (profile?.siteType === 'ai_consultancy') {
    return [
      intro,
      'Gör den tydligare som en AI/kod/automationstjänst: konkreta case, köparproblem, leveransform, risker/fallgropar, proof och nästa steg för företag som överväger hjälp.',
      'Målet är att sidan ska bygga förtroende och visa praktisk expertis, inte bara nämna keywords.'
    ].join(' ')
  }
  return ''
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

function rollbackComponents() {
  return [{
    type: 1,
    components: [
      { type: 2, custom_id: 'seo-revert:commit', label: 'Backa', style: 4 }
    ]
  }]
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
    `Svara i vanlig svenska om GSC kan ignoreras, om det kan vänta, eller om du vill att jag förklarar mer.`
  ]
  return lines.filter(Boolean).join('\n').slice(0, 1900)
}

function isGscAuthAction(action) {
  const text = `${action.title || ''} ${action.why || ''} ${action.recommendedAction || ''}`.toLowerCase()
  return text.includes('oauth-tokenutbyte')
    || /oauth|token|refresh-token|reconnect|koppla-om|logga-in|not_connected|invalid_grant/.test(text)
    || (/url inspection-fel/.test(text) && /oauth|token|reconnect|koppla/.test(text))
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
    if (!components.length && !/knapp|kör|hoppa|vänta|vanta|hanterad|förklara/i.test(text)) return { reason: 'action_card:missing_decision_options', severity: 'review' }
  }
  if (kind === 'decision_confirmation') {
    if (!/Decision|decision|beslut|handled|stored|approved|skipped|deprioritized|send_approved/.test(text)) return { reason: 'decision_confirmation:missing_decision', severity: 'review' }
  }
  if (kind === 'code_result') {
    if (!/Kodaction klar|Commit:|GitHub:|Backa/i.test(text)) return { reason: 'code_result:missing_commit_context', severity: 'review' }
  }
  if (kind === 'status_summary') {
    if (!/status|Actions:|Nästa:|OK|FIX|OAuth|online|redo|saknas/i.test(text)) return { reason: 'status_summary:missing_status_signal', severity: 'review' }
  }
  if (kind === 'error_notice') {
    if (!/Fel:|Orsak:|misslyckades|Kunde inte|Självläkning|Fix:/i.test(text)) return { reason: 'error_notice:missing_error_or_fix', severity: 'review' }
  }
  if (kind === 'chat_reply') {
    if (/approve seo_action_/.test(text) && !/varför|nästa|rekommender/i.test(text.toLowerCase())) return { reason: 'chat_reply:command_without_explanation', severity: 'review' }
    if (/\b(approve|skip|deprioritize|doctor|status|why)\s+seo_action_/i.test(text)) return { reason: 'chat_reply:text_command_leaked', severity: 'review' }
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
    command: `${codexCli} exec --json --cd /home/deploy/seo-agent-discord --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`,
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
      'Försök igen om en stund, eller fråga mig i chatten vad nästa steg är.'
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
    if (label && !label.includes(site) && lower.includes(site)) return { reason: `cross_workspace_reference:${site}_in_${label}` }
  }
  const repo = String(workspace?.repoFullName || '').toLowerCase()
  const knownRepos = ['sajden/sebcastwall', 'sajden/natverkskollen', 'sajden/parkeringspolaren-web']
  for (const knownRepo of knownRepos) {
    if (repo && !repo.includes(knownRepo) && lower.includes(knownRepo)) return { reason: `cross_workspace_repo:${knownRepo}_in_${repo}` }
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
  let payload = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      const contentType = response.headers.get('content-type') || 'unknown content-type'
      const preview = text.replace(/\s+/g, ' ').slice(0, 200)
      throw new Error(`discord_${response.status}_invalid_json: ${path} returned ${contentType} · ${preview}`)
    }
  }
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
  const parsed = keys.map(parseWorkspaceChannelKey)
  const gscProperty = parsed.find((item) => item.gscProperty)?.gscProperty || ''
  const repoFullName = parsed.find((item) => item.repoFullName)?.repoFullName || ''
  const branch = parsed.find((item) => item.branch)?.branch || 'main'
  const labelKey = parsed.find((item) => item.label)?.label || gscProperty || repoFullName || keys[0]
  const site = normalizeGscPropertyHost(gscProperty)
  return {
    id: `${gscProperty || labelKey}__${repoFullName || ''}__${branch}`,
    label: site || labelKey,
    gscProperty: gscProperty || undefined,
    repoFullName: repoFullName || undefined,
    branch
  }
}

function parseWorkspaceChannelKey(key) {
  const raw = String(key || '').trim()
  const parts = raw.split('__')
  if (parts.length >= 2) {
    const [propertyOrLabel, repoFullName, branch] = parts
    return {
      label: propertyOrLabel && !propertyOrLabel.startsWith('sc-domain:') && !/^https?:\/\//i.test(propertyOrLabel) ? propertyOrLabel : '',
      gscProperty: propertyOrLabel && (propertyOrLabel.startsWith('sc-domain:') || /^https?:\/\//i.test(propertyOrLabel)) ? propertyOrLabel : '',
      repoFullName: repoFullName || '',
      branch: branch || 'main'
    }
  }
  return {
    label: !raw.startsWith('sc-domain:') && !/^https?:\/\//i.test(raw) && !/^[^\s/:]+\/[^\s/]+$/.test(raw) ? raw : '',
    gscProperty: raw.startsWith('sc-domain:') || /^https?:\/\//i.test(raw) ? raw : '',
    repoFullName: /^[^\s/:]+\/[^\s/]+$/.test(raw) ? raw : '',
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
