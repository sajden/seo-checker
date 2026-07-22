#!/usr/bin/env node
import http from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const env = loadEnv(['/opt/ai-dashboard/apps/seo-runtime/.env', '/opt/ai-dashboard/apps/seo-agent-discord/.env', '/home/deploy/seo-agent-discord/.env'])
const host = env.SEO_RUNTIME_HOST || '127.0.0.1'
const port = Number(env.SEO_RUNTIME_PORT || '1460')
const statePath = env.SEO_RUNTIME_STATE_PATH || '/opt/ai-dashboard/apps/seo-agent-discord/state/state.json'
const runtimeKey = 'seo-agent'
const platformApiUrl = (env.PLATFORM_API_URL || 'https://dashboard2-platform-api.sebastian-castwall.workers.dev').replace(/\/$/, '')
const platformToken = env.PLATFORM_API_TOKEN || ''
const exec = promisify(execFile)
const stateDir = dirname(statePath)
const codeRunnerPath = env.SEO_RUNTIME_CODE_RUNNER_PATH || '/opt/ai-dashboard/apps/seo-agent-discord/codex-runner.mjs'
const seoAgentAppRoot = env.SEO_AGENT_APP_ROOT || dirname(codeRunnerPath)
const gscUrlInspectionToolPath = env.SEO_RUNTIME_GSC_URL_INSPECTION_TOOL_PATH || join(seoAgentAppRoot, 'gsc-url-inspection-api.mjs')
const gscFirefoxUiToolPath = env.SEO_RUNTIME_GSC_FIREFOX_UI_TOOL_PATH || join(seoAgentAppRoot, 'gsc-firefox-ui-tool.mjs')
const gscOauthRedirectUri = env.GSC_REDIRECT_URI || env.GOOGLE_SEARCH_CONSOLE_REDIRECT_URI || 'https://seo-api.sebcastwall.se/api/gsc/callback'
const gscOauthState = env.GSC_OAUTH_STATE || 'seo-agent-gsc-oauth'
const googleAdsOauthRedirectUri = env.GOOGLE_ADS_OAUTH_REDIRECT_URI || 'http://localhost:1455/oauth/google-ads/callback'
const googleAdsOauthState = env.GOOGLE_ADS_OAUTH_STATE || 'seo-agent-google-ads-oauth'

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(response, 500, { ok: false, error: error?.message || String(error) })
  })
})

server.listen(port, host, () => {
  log('seo_runtime_started', { host, port, statePath })
})

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`)
  if (request.method === 'GET' && url.pathname === '/healthz') {
    const state = readState()
    return sendJson(response, 200, {
      ok: true,
      runtimeKey,
      statePath,
      actionLedgerCount: Object.keys(state.actionLedger || {}).length,
      codeActionResultsCount: Object.keys(state.codeActionResults || {}).length
    })
  }
  if (request.method === 'GET' && url.pathname === '/seo/today') {
    const limit = clampNumber(url.searchParams.get('limit'), 1, 100, 20)
    const workspace = url.searchParams.get('workspace') || url.searchParams.get('workspaceKey') || ''
    const includeLedger = ['1', 'true', 'yes'].includes(String(url.searchParams.get('includeLedger') || '').toLowerCase())
    return sendJson(response, 200, {
      ok: true,
      runtimeKey,
      actions: currentActions(readState(), { workspace, limit, includeLedger })
    })
  }
  if (request.method === 'POST' && url.pathname === '/seo/tick/advice') {
    const body = await readJsonBody(request)
    const result = tickAdvice(body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  if (request.method === 'POST' && url.pathname === '/seo/integrations/gsc/doctor') {
    const body = await readJsonBody(request)
    const result = await gscDoctor(body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  if (request.method === 'POST' && url.pathname === '/seo/integrations/gsc/oauth/start') {
    const result = gscOauthStart()
    return sendJson(response, result.statusCode || 200, result.body)
  }
  if (request.method === 'POST' && url.pathname === '/seo/integrations/gsc/oauth/exchange') {
    const body = await readJsonBody(request)
    const result = await exchangeGscOauth(body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  if (request.method === 'POST' && url.pathname === '/seo/integrations/google-ads/oauth/start') {
    const result = googleAdsOauthStart()
    return sendJson(response, result.statusCode || 200, result.body)
  }
  if (request.method === 'POST' && url.pathname === '/seo/integrations/google-ads/oauth/exchange') {
    const body = await readJsonBody(request)
    const result = await exchangeGoogleAdsOauth(body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  if (request.method === 'POST' && url.pathname === '/seo/integrations/gsc/url-inspection') {
    const body = await readJsonBody(request)
    const result = await inspectGscUrl(body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  const nextMatch = url.pathname.match(/^\/seo\/workspaces\/([^/]+)\/actions\/next$/)
  if (request.method === 'POST' && nextMatch) {
    const workspaceKey = decodeURIComponent(nextMatch[1])
    const body = await readJsonBody(request)
    const result = selectNextAction(workspaceKey, body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  const currentMatch = url.pathname.match(/^\/seo\/workspaces\/([^/]+)\/actions\/current$/)
  if (request.method === 'POST' && currentMatch) {
    const workspaceKey = decodeURIComponent(currentMatch[1])
    const body = await readJsonBody(request)
    const result = await fetchCurrentAction(workspaceKey, body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  const liveMatch = url.pathname.match(/^\/seo\/workspaces\/([^/]+)\/actions\/live$/)
  if (request.method === 'POST' && liveMatch) {
    const workspaceKey = decodeURIComponent(liveMatch[1])
    const body = await readJsonBody(request)
    const result = await fetchLiveActions(workspaceKey, body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  const executeMatch = url.pathname.match(/^\/seo\/actions\/([^/]+)\/execute$/)
  if (request.method === 'POST' && executeMatch) {
    const actionId = decodeURIComponent(executeMatch[1])
    const body = await readJsonBody(request)
    const result = executeAction(actionId, body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  const postedMatch = url.pathname.match(/^\/seo\/actions\/([^/]+)\/posted$/)
  if (request.method === 'POST' && postedMatch) {
    const actionId = decodeURIComponent(postedMatch[1])
    const body = await readJsonBody(request)
    const result = markActionPosted(actionId, body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  if (request.method === 'POST' && url.pathname === '/seo/actions/run-next') {
    const body = await readJsonBody(request)
    const result = await runNextApprovedCodeAction(body)
    return sendJson(response, result.statusCode || 200, result.body)
  }
  sendJson(response, 404, { ok: false, error: 'not_found' })
}

function currentActions(state, { workspace = '', limit = 20, includeLedger = false } = {}) {
  const workspaceNeedle = normalize(workspace)
  const actions = []
  const resultById = state.codeActionResults || {}
  const activeByWorkspace = state.activeActionByWorkspace || {}

  for (const item of Object.values(state.approvedCodeActionQueue || {})) {
    if (!item?.id || resultById[item.id]) continue
    actions.push(normalizeRuntimeAction(item, 'approved', { source: 'approvedCodeActionQueue' }))
  }

  for (const active of Object.values(activeByWorkspace)) {
    if (!active?.actionId || resultById[active.actionId]) continue
    const posted = state.postedActionIds?.[active.actionId] || {}
    actions.push(normalizeRuntimeAction({
      id: active.actionId,
      title: active.title || posted.title || active.actionId,
      workspaceId: active.workspaceId || posted.workspaceId || '',
      channelId: active.channelId || posted.channelId || '',
      messageId: active.messageId || posted.messageId || '',
      targetUrl: posted.targetUrl || '',
      keyword: posted.keyword || ''
    }, 'pending', { source: 'activeActionByWorkspace' }))
  }

  if (includeLedger) {
    for (const ledger of Object.values(state.actionLedger || {})) {
      if (!ledger?.actionId || resultById[ledger.actionId]) continue
      if (!['approved', 'coding'].includes(String(ledger.status || ''))) continue
      actions.push(normalizeRuntimeAction({
        id: ledger.actionId,
        title: ledger.title || ledger.actionId,
        workspaceId: ledger.workspaceKey || '',
        targetUrl: ledger.targetUrl || '',
        keyword: ledger.keyword || '',
        priority: ledger.priority || '',
        updatedAt: ledger.lastEventAt || ledger.firstSeenAt || '',
        createdAt: ledger.firstSeenAt || ''
      }, ledger.status || 'pending', { source: 'actionLedger' }))
    }
  }

  const deduped = []
  const seen = new Set()
  for (const action of actions) {
    if (!action.id || seen.has(action.id)) continue
    seen.add(action.id)
    if (workspaceNeedle && !actionMatchesWorkspace(action, workspaceNeedle)) continue
    deduped.push(action)
  }
  return deduped
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .slice(0, limit)
}

function tickAdvice(payload = {}) {
  const state = readState()
  const nowMs = Number.isFinite(Date.parse(payload.now)) ? Date.parse(payload.now) : Date.now()
  const today = new Date(nowMs).toISOString().slice(0, 10)
  const dailyHourUtc = clampNumber(payload.dailyHourUtc, 0, 23, 4)
  const intervals = payload.intervals && typeof payload.intervals === 'object' ? payload.intervals : {}
  const steps = {
    processDiscordReplies: true,
    listWorkspaces: true,
    syncWorkspaceRepoCommits: dueByInterval(state.lastRepoCommitSyncAt, nowMs, intervals.repoCommitSyncMs, 15 * 60 * 1000),
    ensureDailyRunsForWorkspaces: dueDailyRunCheck(state, nowMs, dailyHourUtc, intervals.runCheckMs),
    runDailyRankingReviews: new Date(nowMs).getUTCHours() >= dailyHourUtc,
    postReadinessForWorkspaces: true,
    checkGscIssuesForWorkspaces: dueByInterval(state.lastGscIssueCheckAt, nowMs, intervals.gscIssueCheckMs, 6 * 60 * 60 * 1000),
    postPendingActionsForWorkspaces: true,
    prepareAutonomousCodeWork: true,
    runIntegrationDoctor: dueByInterval(state.lastIntegrationDoctorAt, nowMs, intervals.integrationDoctorMs, 12 * 60 * 60 * 1000),
    askForGscApiOauth: true
  }
  state.runtimeTickAdvice = {
    ...(state.runtimeTickAdvice || {}),
    lastAdviceAt: new Date(nowMs).toISOString()
  }
  writeState(state)
  return {
    statusCode: 200,
    body: {
      ok: true,
      runtimeKey,
      today,
      generatedAt: new Date(nowMs).toISOString(),
      steps
    }
  }
}

function dueByInterval(lastAt, nowMs, intervalInput, fallbackMs) {
  const intervalMs = clampNumber(intervalInput, 60 * 1000, 7 * 24 * 60 * 60 * 1000, fallbackMs)
  const lastMs = Date.parse(lastAt || '')
  return !lastMs || nowMs - lastMs >= intervalMs
}

function dueDailyRunCheck(state, nowMs, dailyHourUtc, intervalInput) {
  const now = new Date(nowMs)
  if (now.getUTCHours() < dailyHourUtc) return false
  return dueByInterval(state.lastRunCheckAt, nowMs, intervalInput, 15 * 60 * 1000)
}

async function gscDoctor(payload = {}) {
  const command = payload.deep === true ? 'doctor' : 'doctor-shallow'
  const api = await runGscUrlInspectionApiTool({ command }).catch((error) => ({
    ok: false,
    command,
    status: 'api_tool_failed',
    error: error?.message || String(error)
  }))
  const browser = payload.includeBrowser === false
    ? null
    : await runGscFirefoxUiTool({ command: 'doctor' }).catch((error) => ({
      ok: false,
      command: 'doctor',
      status: 'browser_tool_failed',
      error: error?.message || String(error)
    }))
  return {
    statusCode: 200,
    body: {
      ok: Boolean(api.ok || browser?.ok),
      runtimeKey,
      api,
      browser,
      preferred: api.ok ? 'api' : browser?.ok ? 'browser' : 'none'
    }
  }
}

function gscOauthStart() {
  const clientId = gscClientId()
  const clientSecret = gscClientSecret()
  if (!clientId || !clientSecret) {
    return {
      statusCode: 200,
      body: {
        ok: false,
        runtimeKey,
        status: 'missing_oauth_client',
        missing: [
          !clientId ? 'GSC_CLIENT_ID or GOOGLE_SEARCH_CONSOLE_CLIENT_ID' : '',
          !clientSecret ? 'GSC_CLIENT_SECRET or GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET' : ''
        ].filter(Boolean)
      }
    }
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: gscOauthRedirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state: gscOauthState
  })
  return {
    statusCode: 200,
    body: {
      ok: true,
      runtimeKey,
      status: 'ready',
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      redirectUri: gscOauthRedirectUri,
      state: gscOauthState
    }
  }
}

async function exchangeGscOauth(payload = {}) {
  const code = String(payload.code || '').trim()
  if (!code) return { statusCode: 400, body: { ok: false, runtimeKey, error: 'missing_code' } }
  const clientId = gscClientId()
  const clientSecret = gscClientSecret()
  if (!clientId || !clientSecret) return { statusCode: 400, body: { ok: false, runtimeKey, error: 'missing_oauth_client' } }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: gscOauthRedirectUri,
      grant_type: 'authorization_code'
    })
  })
  const tokenPayload = await response.json().catch(() => ({}))
  if (!response.ok) {
    return {
      statusCode: 200,
      body: {
        ok: false,
        runtimeKey,
        status: `google_oauth_${response.status}`,
        error: tokenPayload.error_description || tokenPayload.error || `google_oauth_${response.status}`
      }
    }
  }
  const refreshToken = tokenPayload.refresh_token ? String(tokenPayload.refresh_token) : ''
  if (!refreshToken) {
    return { statusCode: 200, body: { ok: false, runtimeKey, status: 'missing_refresh_token', error: 'Google returned no refresh token' } }
  }
  writeFileSync(join(stateDir, 'gsc-refresh-token.txt'), refreshToken, { mode: 0o600 })
  const doctor = await runGscUrlInspectionApiTool({ command: 'doctor' }).catch((error) => ({ ok: false, status: 'doctor_failed', error: error?.message || String(error) }))
  return {
    statusCode: 200,
    body: {
      ok: true,
      runtimeKey,
      status: 'refresh_token_saved',
      tokenSaved: true,
      doctor
    }
  }
}

function gscClientId() {
  return env.GSC_CLIENT_ID || env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || ''
}

function gscClientSecret() {
  return env.GSC_CLIENT_SECRET || env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || ''
}

function googleAdsOauthStart() {
  const clientId = env.GOOGLE_ADS_CLIENT_ID || ''
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET || ''
  if (!clientId || !clientSecret) {
    return {
      statusCode: 200,
      body: {
        ok: false,
        runtimeKey,
        status: 'missing_oauth_client',
        missing: [
          !clientId ? 'GOOGLE_ADS_CLIENT_ID' : '',
          !clientSecret ? 'GOOGLE_ADS_CLIENT_SECRET' : ''
        ].filter(Boolean)
      }
    }
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleAdsOauthRedirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline',
    prompt: 'consent',
    state: googleAdsOauthState
  })
  return {
    statusCode: 200,
    body: {
      ok: true,
      runtimeKey,
      status: 'ready',
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      redirectUri: googleAdsOauthRedirectUri,
      state: googleAdsOauthState
    }
  }
}

async function exchangeGoogleAdsOauth(payload = {}) {
  const code = String(payload.code || '').trim()
  if (!code) return { statusCode: 400, body: { ok: false, runtimeKey, error: 'missing_code' } }
  const clientId = env.GOOGLE_ADS_CLIENT_ID || ''
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET || ''
  if (!clientId || !clientSecret) return { statusCode: 400, body: { ok: false, runtimeKey, error: 'missing_oauth_client' } }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleAdsOauthRedirectUri,
      grant_type: 'authorization_code'
    })
  })
  const tokenPayload = await response.json().catch(() => ({}))
  if (!response.ok) {
    return {
      statusCode: 200,
      body: {
        ok: false,
        runtimeKey,
        status: `google_oauth_${response.status}`,
        error: tokenPayload.error_description || tokenPayload.error || `google_oauth_${response.status}`
      }
    }
  }
  const refreshToken = tokenPayload.refresh_token ? String(tokenPayload.refresh_token) : ''
  if (!refreshToken) {
    return { statusCode: 200, body: { ok: false, runtimeKey, status: 'missing_refresh_token', error: 'Google returned no refresh token' } }
  }
  writeFileSync(join(stateDir, 'google-ads-refresh-token.txt'), refreshToken, { mode: 0o600 })
  const platformSync = await syncGoogleAdsRefreshTokenToPlatform(refreshToken)
  return {
    statusCode: 200,
    body: {
      ok: true,
      runtimeKey,
      status: 'refresh_token_saved',
      tokenSaved: true,
      platformSync
    }
  }
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

async function inspectGscUrl(payload = {}) {
  const input = {
    ...payload,
    command: 'inspect-url'
  }
  const apiResult = await runGscUrlInspectionApiTool(input).catch((error) => ({
    ok: false,
    command: 'inspect-url',
    status: 'api_exception',
    error: error?.message || String(error)
  }))
  const shouldFallbackToUi = !apiResult.ok && /missing_oauth_config|google_api_401|google_api_403|api_exception|invalid_refresh_token/i.test(String(apiResult.status || apiResult.error || ''))
  const result = apiResult.ok
    ? apiResult
    : shouldFallbackToUi
      ? await runGscFirefoxUiTool(input)
        .then((uiResult) => ({ ...uiResult, apiFallbackReason: apiResult.error || apiResult.status || 'api_unavailable' }))
        .catch((error) => ({ ok: false, command: 'inspect-url', status: 'ui_exception', error: error?.message || String(error), apiFallbackReason: apiResult.error || apiResult.status || 'api_unavailable' }))
      : apiResult
  return {
    statusCode: 200,
    body: {
      ok: Boolean(result.ok),
      runtimeKey,
      source: apiResult.ok ? 'google_url_inspection_api' : shouldFallbackToUi ? 'gsc_firefox_ui' : 'google_url_inspection_api',
      result
    }
  }
}

async function runGscUrlInspectionApiTool(input) {
  return runJsonNodeTool(gscUrlInspectionToolPath, input, 'gsc-url-inspection-api')
}

async function runGscFirefoxUiTool(input) {
  return runJsonNodeTool(gscFirefoxUiToolPath, input, 'gsc-firefox-ui')
}

async function runJsonNodeTool(toolPath, input, prefix) {
  const inputPath = join(stateDir, `${prefix}-input.${process.pid}.${Date.now()}.json`)
  writeFileSync(inputPath, JSON.stringify(input, null, 2))
  const result = await exec('/usr/bin/node', [toolPath, inputPath], {
    cwd: seoAgentAppRoot,
    env: {
      ...process.env,
      PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}`
    },
    timeout: input.command === 'inspect-url' ? 5 * 60 * 1000 : 60 * 1000,
    maxBuffer: 4 * 1024 * 1024
  })
  return JSON.parse(result.stdout || '{}')
}

function normalizeRuntimeAction(input, status = 'pending', meta = {}) {
  const id = String(input.id || input.actionId || '')
  const workspaceKey = String(input.workspaceId || input.workspaceKey || input.workspaceSlug || input.projectSlug || '')
  const title = String(input.title || id || 'SEO action')
  const targetUrl = String(input.targetUrl || input.url || '')
  const keyword = String(input.keyword || '')
  return {
    id,
    runtimeKey,
    moduleKey: 'seo-monitor',
    actionType: inferActionType({ title, targetUrl, keyword }),
    title,
    summary: shortSummary({ title, targetUrl, keyword }),
    why: String(input.why || input.reason || 'SEO-agenten har denna action i runtime-state.').slice(0, 500),
    recommendedAction: String(input.recommendedAction || input.doThis || defaultRecommendedAction(status)).slice(0, 800),
    allowedDecisions: allowedDecisionsForStatus(status),
    status: normalizeStatus(status),
    createdAt: input.createdAt || input.postedAt || input.firstSeenAt || new Date().toISOString(),
    updatedAt: input.updatedAt || input.lastEventAt || input.queuedAt || input.postedAt || new Date().toISOString(),
    workspaceKey,
    channelId: input.channelId || '',
    messageId: input.messageId || '',
    targetUrl,
    keyword,
    evidence: input.evidence || [],
    riskFlags: input.riskFlags || [],
    source: meta.source || input.source || 'state'
  }
}

async function fetchLiveActions(workspaceKey, payload = {}) {
  const limit = clampNumber(payload.limit, 1, 50, 10)
  const workspace = payload.workspace && typeof payload.workspace === 'object' ? payload.workspace : {}
  const includeGscProperty = payload.includeGscProperty !== false
  const path = buildPlatformSeoActionsPath(workspace, limit, { includeGscProperty })
  try {
    const platformPayload = await fetchPlatformJson(path)
    if (!platformPayload || !Array.isArray(platformPayload.actions)) {
      return {
        statusCode: 502,
        body: {
          ok: false,
          runtimeKey,
          workspaceKey,
          error: 'platform_actions_shape_invalid',
          path
        }
      }
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        runtimeKey,
        workspaceKey,
        source: 'platform',
        path,
        actions: platformPayload.actions,
        workspacePolicy: platformPayload.workspacePolicy || '',
        workspace: platformPayload.workspace || null,
        raw: payload.includeRaw ? platformPayload : undefined
      }
    }
  } catch (error) {
    const message = error?.message || String(error)
    return {
      statusCode: platformErrorStatusCode(message),
      body: {
        ok: false,
        runtimeKey,
        workspaceKey,
        error: message,
        path,
        resourceLimit: isPlatformResourceLimitError(message),
        missingBatch: isSeoBatchNotFoundError(message)
      }
    }
  }
}

function buildPlatformSeoActionsPath(workspace, limit, options = {}) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (workspace && Object.keys(workspace).length) {
    if (options.includeGscProperty !== false) params.set('gscProperty', workspace.gscProperty || '')
    params.set('repoFullName', workspace.repoFullName || '')
    params.set('branch', workspace.branch || '')
  }
  return `/api/platform/seo-monitor/actions?${params.toString()}`
}

async function fetchPlatformJson(path, init = {}) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
    ...(platformToken ? { authorization: `Bearer ${platformToken}` } : {}),
    ...(init.headers || {})
  }
  const response = await fetch(`${platformApiUrl}${path}`, { ...init, headers })
  const text = await response.text()
  const contentType = response.headers.get('content-type') || ''
  let payload = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
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

function platformErrorStatusCode(message) {
  const match = String(message || '').match(/platform_(\d{3})/)
  const status = match ? Number(match[1]) : 502
  return Number.isFinite(status) && status >= 400 && status < 600 ? status : 502
}

function isSeoBatchNotFoundError(message) {
  return String(message || '').toLowerCase().includes('seo_batch_not_found')
}

function isPlatformResourceLimitError(message) {
  const text = String(message || '').toLowerCase()
  return text.includes('platform_503') && (text.includes('error 1102') || text.includes('resource limit'))
}

async function fetchCurrentAction(workspaceKey, payload = {}) {
  const live = await fetchLiveActions(workspaceKey, payload)
  if (live.body?.ok === false) return live
  const actions = Array.isArray(live.body?.actions) ? live.body.actions : []
  const next = selectNextAction(workspaceKey, {
    ...payload,
    actions,
    workspacePolicy: live.body?.workspacePolicy || payload.workspacePolicy || ''
  })
  return {
    statusCode: next.statusCode || 200,
    body: {
      ...(next.body || {}),
      source: 'runtime_current',
      actions,
      workspacePolicy: live.body?.workspacePolicy || '',
      workspace: live.body?.workspace || payload.workspace || null,
      liveSource: live.body?.source || ''
    }
  }
}

function executeAction(actionId, payload = {}) {
  if (!actionId) return { statusCode: 400, body: { ok: false, error: 'missing_action_id' } }
  const decision = normalizeDecision(payload.decision)
  if (!decision) return { statusCode: 400, body: { ok: false, error: 'unsupported_decision' } }
  const idempotencyKey = String(payload.idempotencyKey || '').trim()
  if (!idempotencyKey) return { statusCode: 400, body: { ok: false, error: 'missing_idempotency_key' } }

  const state = readState()
  state.runtimeExecutions = state.runtimeExecutions || {}
  const previous = state.runtimeExecutions[idempotencyKey]
  if (previous) return { statusCode: 200, body: { ok: true, idempotent: true, result: previous } }

  const existingResult = state.codeActionResults?.[actionId]
  if (existingResult?.status === 'completed' && decision === 'approved') {
    const result = { status: 'already_completed', actionId, commit: existingResult.result?.commit || null, at: new Date().toISOString() }
    state.runtimeExecutions[idempotencyKey] = result
    writeState(state)
    return { statusCode: 200, body: { ok: true, result } }
  }

  const action = findAction(state, actionId)
  if (!action) return { statusCode: 404, body: { ok: false, error: 'action_not_found', actionId } }

  const now = new Date().toISOString()
  const operatorId = String(payload.operatorId || '').trim()
  const reason = String(payload.reason || '').trim().slice(0, 500)
  const result = { status: decision, actionId, operatorId, reason, at: now }

  if (decision === 'approved') {
    state.approvedCodeActionQueue = state.approvedCodeActionQueue || {}
    if (!state.approvedCodeActionQueue[actionId] && !state.codeActionResults?.[actionId]) {
      state.approvedCodeActionQueue[actionId] = {
        ...action,
        id: actionId,
        approvedAt: now,
        queuedAt: now,
        operatorId,
        reason,
        runtimeDecision: true
      }
    }
    result.status = state.codeActionResults?.[actionId] ? 'already_result_exists' : 'queued'
  } else {
    updateLedgerForDecision(state, action, decision, { operatorId, reason, at: now })
    clearActiveForAction(state, actionId)
  }

  state.runtimeExecutions[idempotencyKey] = result
  writeState(state)
  return { statusCode: 200, body: { ok: true, result } }
}

function markActionPosted(actionId, payload = {}) {
  if (!actionId) return { statusCode: 400, body: { ok: false, error: 'missing_action_id' } }
  const messageId = String(payload.messageId || '').trim()
  const channelId = String(payload.channelId || '').trim()
  if (!messageId || !channelId) return { statusCode: 400, body: { ok: false, error: 'missing_message_or_channel' } }
  const idempotencyKey = String(payload.idempotencyKey || `posted:${channelId}:${messageId}:${actionId}`).trim()
  const state = readState()
  state.runtimeExecutions = state.runtimeExecutions || {}
  if (state.runtimeExecutions[idempotencyKey]) return { statusCode: 200, body: { ok: true, idempotent: true, result: state.runtimeExecutions[idempotencyKey] } }

  const now = new Date().toISOString()
  const action = payload.action && typeof payload.action === 'object' ? payload.action : { id: actionId, title: actionId }
  const workspace = payload.workspace && typeof payload.workspace === 'object' ? payload.workspace : {}
  const activeKey = String(payload.activeKey || workspace.id || workspace.gscProperty || workspace.repoFullName || channelId || 'default')
  const systemKey = String(payload.systemKey || '')
  const review = payload.review && typeof payload.review === 'object' ? payload.review : null
  const posted = {
    messageId,
    channelId,
    title: action.title || actionId,
    workspaceId: workspace.id || action.workspaceId || null,
    targetUrl: action.targetUrl || action.url || '',
    keyword: action.keyword || '',
    postedAt: now
  }
  state.postedActionIds = state.postedActionIds || {}
  state.postedActionIds[actionId] = posted
  state.activeActionByWorkspace = state.activeActionByWorkspace || {}
  state.activeActionByWorkspace[activeKey] = {
    actionId,
    messageId,
    channelId,
    workspaceId: workspace.id || action.workspaceId || null,
    firstPostedAt: now,
    postedAt: now,
    title: action.title || actionId
  }
  state.messageToAction = state.messageToAction || {}
  state.messageToAction[messageId] = actionId
  if (systemKey) {
    state.postedSystemKeys = state.postedSystemKeys || {}
    state.postedSystemKeys[systemKey] = { actionId, messageId, postedAt: now }
  }
  recordRuntimeLedgerEvent(state, { ...action, id: actionId }, workspace, 'posted', {
    messageId,
    systemKey: systemKey || undefined,
    guard: payload.guard || undefined,
    review: review || undefined,
    source: 'seo-runtime'
  })
  const result = { status: 'posted', actionId, messageId, channelId, activeKey, at: now }
  state.runtimeExecutions[idempotencyKey] = result
  writeState(state)
  return { statusCode: 200, body: { ok: true, result, posted, active: state.activeActionByWorkspace[activeKey] } }
}

async function runNextApprovedCodeAction(payload = {}) {
  const state = readState()
  if (state.codeActionRunning) {
    return { statusCode: 200, body: { ok: true, ran: false, reason: 'already_running', running: state.codeActionRunning } }
  }
  state.codeActionResults = state.codeActionResults || {}
  state.approvedCodeActionQueue = state.approvedCodeActionQueue || {}
  const entries = Object.values(state.approvedCodeActionQueue)
    .filter((item) => item?.id)
    .sort((a, b) => Date.parse(b.queuedAt || 0) - Date.parse(a.queuedAt || 0))
  const entry = entries.find((item) => !state.codeActionResults?.[item.id])
  if (!entry) return { statusCode: 200, body: { ok: true, ran: false, reason: 'queue_empty' } }

  const now = new Date().toISOString()
  const workspace = {
    label: entry.workspaceSlug || entry.workspaceLabel || entry.repoFullName || 'workspace',
    repoFullName: entry.repoFullName || '',
    branch: entry.branch || 'main'
  }
  state.codeActionRunning = { actionId: entry.id, startedAt: now, source: 'seo-runtime' }
  recordRuntimeLedgerEvent(state, entry, workspace, 'coding_started', { source: 'seo-runtime' })
  writeState(state)

  try {
    const result = await runCodexAction(entry)
    const completedResult = {
      ...result,
      repoFullName: entry.repoFullName || result.repoFullName || null,
      branch: result.deliveryBranch || result.branch || entry.branch || 'main'
    }
    const resultStatus = result.requiresReview ? 'review_ready' : 'completed'
    const resultAt = new Date().toISOString()
    const fresh = readState()
    fresh.codeActionResults = fresh.codeActionResults || {}
    fresh.approvedCodeActionQueue = fresh.approvedCodeActionQueue || {}
    fresh.codeActionResults[entry.id] = {
      status: resultStatus,
      ...(result.requiresReview ? { reviewReadyAt: resultAt } : { completedAt: resultAt }),
      result: completedResult
    }
    delete fresh.approvedCodeActionQueue[entry.id]
    recordRuntimeLedgerEvent(fresh, entry, workspace, resultStatus, {
      commit: result.commit || null,
      diffStat: result.diffStat || null,
      repoFullName: entry.repoFullName || null,
      deliveryBranch: result.deliveryBranch || null,
      reviewUrl: result.reviewUrl || null,
      devUrl: result.devUrl || null,
      source: 'seo-runtime'
    })
    if (!result.requiresReview) {
      clearActiveForAction(fresh, entry.id)
      recordRuntimeSeoExperiment(fresh, entry, workspace, completedResult, { source: 'seo-runtime' })
    }
    fresh.codeActionRunning = null
    writeState(fresh)
    return {
      statusCode: 200,
      body: {
        ok: true,
        ran: true,
        status: resultStatus,
        action: publicAction(entry),
        workspace,
        result: completedResult
      }
    }
  } catch (error) {
    const failure = classifyCodeActionFailure(error)
    const fresh = readState()
    fresh.codeActionResults = fresh.codeActionResults || {}
    fresh.approvedCodeActionQueue = fresh.approvedCodeActionQueue || {}
    fresh.codeActionResults[entry.id] = {
      status: failure.status,
      failedAt: new Date().toISOString(),
      error: error?.message || String(error),
      failure
    }
    delete fresh.approvedCodeActionQueue[entry.id]
    clearActiveForAction(fresh, entry.id)
    recordRuntimeLedgerEvent(fresh, entry, workspace, failure.ledgerEvent, {
      error: error?.message || String(error),
      failure,
      source: 'seo-runtime'
    })
    fresh.codeActionRunning = null
    writeState(fresh)
    return {
      statusCode: 200,
      body: {
        ok: true,
        ran: true,
        status: failure.status,
        action: publicAction(entry),
        workspace,
        error: error?.message || String(error),
        failure
      }
    }
  }
}

async function runCodexAction(action) {
  const inputPath = join(stateDir, `codex-action-input.${process.pid}.${Date.now()}.json`)
  writeFileSync(inputPath, JSON.stringify(action, null, 2))
  const result = await exec('/usr/bin/node', [codeRunnerPath, inputPath], {
    cwd: dirname(codeRunnerPath),
    env: { ...process.env, PATH: `${process.env.HOME || '/home/deploy'}/.npm-global/bin:${process.env.HOME || '/home/deploy'}/.local/bin:${process.env.PATH || ''}` },
    timeout: 45 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024
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
  const text = String(error?.message || error || '').toLowerCase()
  if (text.includes('repo checkout missing') || text.includes('clone failed') || text.includes('could not read from remote repository') || text.includes('permission denied')) {
    return {
      status: 'infra_failed',
      ledgerEvent: 'failed',
      category: 'repo_access',
      retryable: true,
      operatorSummary: 'Repo-checkout eller deploy key saknas. Runnern kan försöka igen när repo-access är fixad.'
    }
  }
  if (text.includes('repo is not clean')) {
    return {
      status: 'infra_failed',
      ledgerEvent: 'failed',
      category: 'dirty_worktree',
      retryable: true,
      operatorSummary: 'Repo-checkouten är dirty. Runnern försöker normalt återhämta avbrutna ändringar innan ny körning.'
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
      operatorSummary: 'Build/test föll efter kodändring. Nästa steg är självläkning eller Codex-reparation.'
    }
  }
  return {
    status: 'failed',
    ledgerEvent: 'failed',
    category: 'unknown',
    retryable: false,
    operatorSummary: 'Okänt fel. Runtime markerar kortet som failed så det inte loopar tyst.'
  }
}

function publicAction(action) {
  return {
    id: action.id || '',
    title: action.title || action.id || '',
    targetUrl: action.targetUrl || action.url || '',
    keyword: action.keyword || '',
    repoFullName: action.repoFullName || '',
    branch: action.branch || 'main',
    channelId: action.channelId || ''
  }
}

function recordRuntimeLedgerEvent(state, action, workspace, event, meta = {}) {
  state.actionLedger = state.actionLedger || {}
  const key = findLedgerKey(state, action.id)
    || `${normalize(workspace?.repoFullName || action.workspaceSlug || action.projectSlug || 'runtime')}:${normalizePath(action.targetUrl || action.url || action.id)}:${actionKindForRuntime(action)}`
  const existing = state.actionLedger[key] || {
    key,
    actionId: action.id,
    title: action.title || action.id,
    workspaceKey: action.workspaceId || action.workspaceSlug || action.projectSlug || workspace?.repoFullName || '',
    targetUrl: action.targetUrl || action.url || '',
    keyword: action.keyword || '',
    firstSeenAt: meta.at || new Date().toISOString(),
    events: []
  }
  const at = meta.at || new Date().toISOString()
  const status = event === 'skipped' ? 'ignored' : event
  state.actionLedger[key] = {
    ...existing,
    status,
    lastEventAt: at,
    commit: meta.commit || existing.commit || null,
    diffStat: meta.diffStat || existing.diffStat || null,
    repoFullName: meta.repoFullName || existing.repoFullName || workspace?.repoFullName || null,
    guardedCount: event === 'guarded' ? Number(existing.guardedCount || 0) + 1 : existing.guardedCount,
    events: [
      { event: status, at, ...meta },
      ...(existing.events || [])
    ].slice(0, 30)
  }
}

function actionKindForRuntime(action) {
  const text = actionText(action)
  if (/intern|internal|link|lank/.test(text)) return 'internal-links'
  if (/new-page|ny-sida|landningssida|serp-gap|content-gap/.test(text)) return 'new-page'
  if (/gsc|indexering|inspection/.test(text)) return 'indexing'
  return 'content'
}

function recordRuntimeSeoExperiment(state, action, workspace, result, meta = {}) {
  state.seoExperiments = state.seoExperiments || {}
  const targetUrl = action.targetUrl || action.url || ''
  const keyword = action.keyword || ''
  const workspaceKey = workspace?.repoFullName || action.workspaceSlug || 'workspace'
  const surface = normalizePath(targetUrl) || normalize(keyword) || 'unknown-surface'
  const unique = normalize(action.id || result?.commit || String(Date.now())) || String(Date.now())
  const id = `${workspaceKey}:${surface}:${unique}`.slice(0, 220)
  const completedAt = new Date().toISOString()
  const reviewDate = new Date(completedAt)
  reviewDate.setDate(reviewDate.getDate() + 14)
  state.seoExperiments[id] = {
    ...(state.seoExperiments[id] || {}),
    id,
    actionId: action.id || null,
    title: action.title || action.id || '',
    workspaceKey: workspace?.repoFullName || action.workspaceSlug || '',
    workspaceLabel: workspace?.label || '',
    repoFullName: result?.repoFullName || workspace?.repoFullName || '',
    branch: result?.branch || workspace?.branch || 'main',
    targetUrl,
    keyword,
    commit: result?.commit || '',
    diffStat: result?.diffStat || '',
    completedAt,
    reviewAfter: reviewDate.toISOString().slice(0, 10),
    source: meta.source || 'seo-runtime',
    baselineStatus: 'pending_gsc_snapshot'
  }
}

function findAction(state, actionId) {
  const queued = state.approvedCodeActionQueue?.[actionId]
  if (queued) return queued
  for (const active of Object.values(state.activeActionByWorkspace || {})) {
    if (String(active?.actionId || '') === actionId) {
      const posted = state.postedActionIds?.[actionId] || {}
      return { id: actionId, title: active.title || posted.title || actionId, ...posted, ...active }
    }
  }
  for (const ledger of Object.values(state.actionLedger || {})) {
    if (String(ledger?.actionId || '') === actionId) {
      return {
        id: actionId,
        title: ledger.title || actionId,
        workspaceId: ledger.workspaceKey || '',
        targetUrl: ledger.targetUrl || '',
        keyword: ledger.keyword || '',
        status: ledger.status || 'pending'
      }
    }
  }
  const posted = state.postedActionIds?.[actionId]
  if (posted) return { id: actionId, title: posted.title || actionId, ...posted }
  return null
}

function updateLedgerForDecision(state, action, decision, meta) {
  state.actionLedger = state.actionLedger || {}
  const key = findLedgerKey(state, action.id) || `${normalize(action.workspaceId || action.workspaceKey || 'runtime')}:${normalize(action.targetUrl || action.id)}`
  const existing = state.actionLedger[key] || {
    key,
    actionId: action.id,
    title: action.title || action.id,
    workspaceKey: action.workspaceId || action.workspaceKey || '',
    targetUrl: action.targetUrl || '',
    keyword: action.keyword || '',
    firstSeenAt: meta.at,
    events: []
  }
  const status = decision === 'skipped' ? 'ignored' : decision === 'deprioritized' ? 'deprioritized' : decision === 'stopped' ? 'stopped' : decision
  state.actionLedger[key] = {
    ...existing,
    status,
    lastEventAt: meta.at,
    events: [
      { event: status, at: meta.at, operatorId: meta.operatorId || '', reason: meta.reason || '', source: 'seo-runtime' },
      ...(existing.events || [])
    ].slice(0, 30)
  }
}

function clearActiveForAction(state, actionId) {
  for (const [key, active] of Object.entries(state.activeActionByWorkspace || {})) {
    if (String(active?.actionId || '') === String(actionId)) delete state.activeActionByWorkspace[key]
  }
}

function findLedgerKey(state, actionId) {
  for (const [key, ledger] of Object.entries(state.actionLedger || {})) {
    if (String(ledger?.actionId || '') === String(actionId)) return key
  }
  return ''
}

function inferActionType({ title, targetUrl, keyword }) {
  const text = normalize(`${title} ${targetUrl} ${keyword}`)
  if (/gsc|indexering|inspection|oauth/.test(text)) return 'seo_integration_check'
  if (/internlank|intern-lank|internal/.test(text)) return 'seo_internal_links'
  return 'seo_code_improvement'
}

function selectNextAction(workspaceKey, payload = {}) {
  const state = readState()
  const actions = Array.isArray(payload.actions) ? payload.actions.filter(Boolean) : []
  const workspace = payload.workspace && typeof payload.workspace === 'object' ? payload.workspace : {}
  const targetChannelId = String(payload.targetChannelId || '')
  const profile = workspaceProfileFor(state, workspaceKey, workspace, targetChannelId)
  const pending = actions.filter((action) => String(action?.status || 'pending') === 'pending')
  const candidates = pending.map((action) => scoreActionCandidate(state, action, {
    workspaceKey,
    workspace,
    targetChannelId,
    profile,
    workspacePolicy: payload.workspacePolicy || ''
  }))
  const accepted = candidates
    .filter((item) => item.ok)
    .sort((a, b) => b.score - a.score || Date.parse(b.action.updatedAt || b.action.createdAt || 0) - Date.parse(a.action.updatedAt || a.action.createdAt || 0))

  const selected = accepted[0] || null
  return {
    statusCode: 200,
    body: {
      ok: true,
      runtimeKey,
      workspaceKey,
      selectedActionId: selected?.action?.id || null,
      selectedAction: selected?.action || null,
      review: selected ? publicCandidateReview(selected) : null,
      rejected: candidates
        .filter((item) => !item.ok)
        .slice(0, 12)
        .map((item) => ({
          id: item.action?.id || '',
          title: item.action?.title || item.action?.id || '',
          score: item.score,
          reason: item.reason,
          negatives: item.negatives.slice(0, 4)
        })),
      candidateCount: candidates.length,
      acceptedCount: accepted.length
    }
  }
}

function scoreActionCandidate(state, action, context) {
  const text = actionText(action)
  const targetUrl = String(action.targetUrl || action.url || '').trim()
  const keyword = String(action.keyword || '').trim()
  const title = String(action.title || action.id || '')
  const positives = []
  const negatives = []
  let score = Number(action.priorityScore ?? action.score ?? NaN)
  if (!Number.isFinite(score)) score = 45

  if (workspaceReviewPending(state, context.workspace)) {
    return rejected(action, -100, 'workspace_review_pending', ['en dev-ändring väntar redan på granskning'])
  }

  const terminal = terminalResultForAction(state, action)
  if (terminal) return rejected(action, -100, `already_result:${terminal}`, [`kodresultat finns redan: ${terminal}`])
  const ledger = ledgerForAction(state, action, context)
  if (ledger?.status === 'completed' && !ledgerRecheckDue(ledger)) return rejected(action, -90, 'already_completed_waiting_recheck', ['liknande action är redan genomförd'])
  if (ledger?.status === 'failed' && !ledgerRecheckDue(ledger)) return rejected(action, -70, 'failed_waiting_recheck', ['liknande action failade nyligen'])
  if (ledger?.status === 'deprioritized' && !ledgerRecheckDue(ledger)) return rejected(action, -55, 'recently_deprioritized_waiting_recheck', ['nyligen bortprioriterad'])
  if (ledger?.status === 'ignored' && !ledgerRecheckDue(ledger)) return rejected(action, -55, 'recently_skipped_waiting_recheck', ['nyligen skippad'])
  const latestEvent = latestLedgerEvent(ledger)
  if (latestEvent?.event === 'guarded' && eventAgeDays(latestEvent) < 7) return rejected(action, -70, 'recently_guarded_waiting_recheck', ['guardad nyligen, väntar på ny vinkel eller färsk data'])
  if (Number(ledger?.guardedCount || 0) >= 2 && !ledgerRecheckDue(ledger)) return rejected(action, -65, 'repeatedly_guarded_waiting_recheck', ['har redan stoppats av agentens guard flera gånger'])

  if (isLegalOrPolicyTarget(targetUrl || title)) return rejected(action, -100, 'legal_or_policy_route_needs_explicit_request', ['legal/admin-sidor ändras inte autonomt'])
  if (isKeywordPlanActionText(text)) return rejected(action, -80, 'keyword_plan_is_strategy_not_action_card', ['keyword-plan behöver brytas ned i konkreta target-URL-actions'])
  if (isGscOrOAuthNoise(text)) return rejected(action, -40, 'integration_check_not_content_work', ['integration/GSC-kontroll är inte SEO-contentarbete'])
  if (!targetUrl && !isNewPageActionText(text)) {
    score -= 25
    negatives.push('saknar target-URL')
  } else if (targetUrl) {
    score += 15
    positives.push('har target-URL')
  }

  const profileText = [context.workspace?.label, context.workspace?.id, context.workspace?.gscProperty, context.workspace?.repoFullName, context.workspaceKey].filter(Boolean).join(' ')
  if (looksLikeWrongWorkspace(text, targetUrl, profileText)) return rejected(action, -100, 'workspace_mismatch', ['actionen ser ut att höra till annan site/workspace'])

  const preferredHits = (context.profile.prefer || []).filter((term) => text.includes(normalize(term)))
  const avoidedHits = (context.profile.avoid || []).filter((term) => text.includes(normalize(term)))
  if (preferredHits.length) {
    score += Math.min(35, preferredHits.length * 12)
    positives.push(`matchar mål: ${preferredHits.slice(0, 3).join(', ')}`)
  }
  if (avoidedHits.length && !preferredHits.length) {
    score -= 45
    negatives.push(`drar mot lågprioriterat: ${avoidedHits.slice(0, 3).join(', ')}`)
  }

  if (isNewPageActionText(text)) {
    score += 18
    positives.push('ny landningssida/content-gap')
  } else if (/intern|internal|lank|lankning|link/.test(text)) {
    score += 8
    positives.push('internlänkning')
  } else if (/content|copy|rubrik|h1|metadata|cta|kommersiell|readiness|skarp|forbattra|expandera/.test(text)) {
    score += 14
    positives.push('sidförbättring')
  }

  if (keyword) {
    const volume = Number(action.keywordMetrics?.avgMonthlySearches || 0)
    if (volume > 0) {
      score += Math.min(22, Math.ceil(volume / 50))
      positives.push(`har sökvolym ${volume}`)
    } else if (/keyword|serp-gap|tack|täck/.test(text)) {
      score -= 10
      negatives.push('keyword saknar verifierad volym')
    }
  }

  if (!action.why && !action.recommendedAction) {
    score -= 15
    negatives.push('svag motivering')
  }
  if (title.length > 140) {
    score -= 8
    negatives.push('onödigt lång titel')
  }

  const ok = score >= 52
  return {
    ok,
    action,
    score: Math.round(score),
    reason: ok ? 'runtime_candidate_selected' : 'runtime_score_too_low',
    positives,
    negatives
  }
}

function workspaceReviewPending(state, workspace) {
  const repoFullName = String(workspace?.repoFullName || '').trim()
  if (!repoFullName || !repoFullName.toLowerCase().includes('sebcastwall')) return false
  return Object.values(state.codeActionResults || {}).some((record) => {
    if (!['review_ready', 'operator_approved'].includes(String(record?.status || ''))) return false
    return String(record?.result?.repoFullName || '').trim() === repoFullName
  })
}

function publicCandidateReview(candidate) {
  return {
    score: candidate.score,
    recommendation: candidate.score >= 78 ? 'Approve' : candidate.score >= 60 ? 'Review' : 'Deprioritize',
    reason: candidate.reason,
    positives: candidate.positives.slice(0, 4),
    negatives: candidate.negatives.slice(0, 4)
  }
}

function rejected(action, score, reason, negatives = []) {
  return { ok: false, action, score, reason, positives: [], negatives }
}

function workspaceProfileFor(state, workspaceKey, workspace, targetChannelId) {
  const keys = [
    workspaceKey,
    workspace?.id,
    workspace?.gscProperty,
    workspace?.repoFullName,
    targetChannelId
  ].filter(Boolean)
  const existing = keys.map((key) => state.workspaceProfiles?.[key]).find(Boolean) || {}
  const label = String(workspace?.label || workspace?.id || workspaceKey || '').toLowerCase()
  const defaults = defaultRuntimeWorkspaceProfile(label)
  return {
    ...defaults,
    ...existing,
    prefer: [...new Set([...(existing.prefer || []), ...(defaults.prefer || [])])],
    avoid: [...new Set([...(existing.avoid || []), ...(defaults.avoid || [])])]
  }
}

function defaultRuntimeWorkspaceProfile(label) {
  if (label.includes('sebcastwall')) {
    return {
      prefer: ['ai', 'ai agent', 'ai agenter', 'ai automatisering', 'ai konsult', 'app', 'webbutveckling', 'kodning', 'utbildning', 'workshop', 'interna verktyg'],
      avoid: ['bokföring', 'faktura', 'visma', 'fortnox', 'ren integration']
    }
  }
  if (label.includes('parkeringspolaren')) {
    return {
      prefer: ['parkering', 'stockholm', 'långtidsparkering', 'flygplats', 'bokning', 'parkeringsapp'],
      avoid: ['smb', 'företagsflöde', 'ai konsult', 'bokföring']
    }
  }
  if (label.includes('vagkollen')) {
    return {
      prefer: ['väder', 'väg', 'trafik', 'road', 'weather', 'route', 'bilresa'],
      avoid: ['smb', 'ai konsult', 'bokföring']
    }
  }
  if (label.includes('natverkskollen')) {
    return {
      prefer: ['event', 'evenemang', 'nätverk', 'startup', 'entreprenör', 'träffar'],
      avoid: ['events-alias', '/events']
    }
  }
  return { prefer: [], avoid: [] }
}

function actionText(action) {
  return normalize([
    action?.id,
    action?.title,
    action?.keyword,
    action?.targetUrl || action?.url,
    action?.why,
    action?.recommendedAction,
    action?.type
  ].filter(Boolean).join(' '))
}

function terminalResultForAction(state, action) {
  const result = state.codeActionResults?.[action?.id]
  if (!result) return ''
  const status = String(result.status || '')
  return ['completed', 'done', 'no_changes', 'reverted', 'review_ready', 'operator_approved', 'rejected'].includes(status) ? status : ''
}

function ledgerForAction(state, action, context) {
  const actionId = String(action?.id || '')
  if (!actionId) return null
  const workspaceKey = runtimeWorkspaceClusterKey(context.workspaceKey)
  const targetPath = normalizePath(action?.targetUrl || action?.url || '')
  const kind = runtimeActionKindForLearning(action)
  if (targetPath && ['content', 'internal-links'].includes(kind)) {
    const exactCluster = `${workspaceKey}:${targetPath}:${kind}`
    if (state.actionLedger?.[exactCluster]) return state.actionLedger[exactCluster]
  }
  for (const ledger of Object.values(state.actionLedger || {})) {
    if (String(ledger?.actionId || '') === actionId) return ledger
  }
  const keyword = normalize(action?.keyword || '')
  let fallbackLedger = null
  for (const ledger of Object.values(state.actionLedger || {})) {
    if (targetPath && normalizePath(ledger?.targetUrl || '') === targetPath && ledgerKindMatchesAction(ledger, kind)) {
      if (isBlockingLedger(ledger)) return ledger
      fallbackLedger = fallbackLedger || ledger
    }
    if (keyword && normalize(ledger?.keyword || '') === keyword && normalize(ledger?.workspaceKey || '').includes(normalize(context.workspaceKey))) return ledger
  }
  return fallbackLedger
}

function ledgerKindMatchesAction(ledger, kind) {
  if (!kind) return true
  const actionKind = runtimeActionKindForLearning(ledger)
  if (actionKind === 'general') return true
  return actionKind === kind || (['content', 'internal-links'].includes(actionKind) && ['content', 'internal-links'].includes(kind))
}

function isBlockingLedger(ledger) {
  if (['review_ready', 'operator_approved'].includes(String(ledger?.status || ''))) return true
  if (['completed', 'failed', 'deprioritized', 'ignored', 'rejected'].includes(String(ledger?.status || '')) && !ledgerRecheckDue(ledger)) return true
  const latestEvent = latestLedgerEvent(ledger)
  if (latestEvent?.event === 'guarded' && eventAgeDays(latestEvent) < 7) return true
  return Number(ledger?.guardedCount || 0) >= 2 && !ledgerRecheckDue(ledger)
}

function runtimeActionKindForLearning(action) {
  const text = actionText(action)
  if (/indexering|url-inspection|gsc|oauth/.test(text) && !/title|h1|meta|copy|faq|content/.test(text)) return 'indexing'
  if (/internlank|interna-lank|internal-link|internal-links|intern-lank|internlankning/.test(text)) return 'internal-links'
  const explicitlyNoNewPage = /skapa-ingen-ny-sida|skapa-inte-ny-sida|ingen-ny-sida|befintlig-sida/.test(text)
  if (!explicitlyNoNewPage && /ny-sida|new-page|skapa-ny.*sida|ny.*landningssida/.test(text)) return 'new-page'
  if (/title|meta|h1|h2|intro|faq|copy|content|readiness|serp|keyword|ranking|kommersiell|skarp|forbattra|expandera/.test(text)) return 'content'
  if (/landningssida/.test(text)) return 'content'
  return 'general'
}

function runtimeWorkspaceClusterKey(value) {
  return normalize(value).replace(/[^a-z0-9/._:-]+/g, '-').replace(/^-+|-+$/g, '')
}

function ledgerRecheckDue(ledger) {
  if (!ledger?.recheckAfter) return false
  return String(ledger.recheckAfter) <= new Date().toISOString().slice(0, 10)
}

function latestLedgerEvent(ledger) {
  const events = Array.isArray(ledger?.events) ? ledger.events : []
  return events[0] || null
}

function eventAgeDays(event) {
  const at = Date.parse(event?.at || '')
  if (!at) return Infinity
  return (Date.now() - at) / (24 * 60 * 60 * 1000)
}

function normalizePath(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.pathname.replace(/\/+$/, '') || '/'
  } catch {
    return raw.replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '') || '/'
  }
}

function isLegalOrPolicyTarget(value) {
  return /(?:^|\/|-)(terms|privacy|integritet|cookie|cookies|legal|terms-of-service|tos|anvandarvillkor|anvandarevillkor|villkor|dataskydd|gdpr)(?:\/|$|-)/i.test(String(value || ''))
}

function isKeywordPlanActionText(text) {
  return /keyword-plan|keywordmap|keyword-map|target-pages|target-sidor|lagg-in-foreslagen-keyword-plan|lagg-in-en-forsta-keyword-plan/.test(text)
}

function isGscOrOAuthNoise(text) {
  return /gsc|search-console|url-inspection|oauth|token|koppling|not-connected|indexering-startsidan|kontrollera-indexering/.test(text)
}

function isNewPageActionText(text) {
  return /new-page|ny-sida|ny-landningssida|landningssida|serp-gap|content-gap|skapa-ny|ny-route|research/.test(text)
}

function looksLikeWrongWorkspace(text, targetUrl, profileText) {
  const host = (() => {
    try { return targetUrl ? new URL(targetUrl).hostname.replace(/^www\./, '') : '' } catch { return '' }
  })()
  const workspaceText = normalize(profileText)
  if (host && workspaceText && !workspaceText.includes(normalize(host)) && !normalize(host).includes(workspaceText.split('-')[0] || workspaceText)) {
    const knownHosts = ['sebcastwall.se', 'parkeringspolaren.se', 'vagkollen.se', 'natverkskollen.se']
    const otherKnownHost = knownHosts.find((known) => normalize(host).includes(normalize(known)) && !workspaceText.includes(normalize(known)))
    if (otherKnownHost) return true
  }
  if (workspaceText.includes('parkeringspolaren') && /ai-agent|ai-konsult|smb|bokforing|fortnox/.test(text)) return true
  if (workspaceText.includes('vagkollen') && /ai-agent|ai-konsult|smb|bokforing|parkering/.test(text)) return true
  return false
}

function shortSummary({ title, targetUrl, keyword }) {
  return [title, targetUrl, keyword ? `Focus: ${keyword}` : ''].filter(Boolean).join(' · ').slice(0, 240)
}

function defaultRecommendedAction(status) {
  if (status === 'approved') return 'Runtime har actionen köad för kodautomation.'
  return 'Välj approve, skip, deprioritize eller stop via Hermes.'
}

function allowedDecisionsForStatus(status) {
  const normalized = normalizeStatus(status)
  if (['completed', 'ignored', 'deprioritized', 'stopped'].includes(normalized)) return []
  return ['approved', 'skipped', 'deprioritized', 'stopped']
}

function normalizeStatus(status) {
  const value = String(status || '').toLowerCase()
  if (value === 'proposed') return 'pending'
  if (value === 'ignored') return 'skipped'
  return value || 'pending'
}

function normalizeDecision(decision) {
  const value = String(decision || '').toLowerCase().trim()
  if (['approve', 'approved', 'run', 'kör', 'kor'].includes(value)) return 'approved'
  if (['skip', 'skipped', 'handled', 'mark_handled'].includes(value)) return 'skipped'
  if (['deprioritize', 'deprioritized', 'wait', 'vänta', 'vanta'].includes(value)) return 'deprioritized'
  if (['stop', 'stopped'].includes(value)) return 'stopped'
  return ''
}

function actionMatchesWorkspace(action, workspaceNeedle) {
  return normalize([
    action.workspaceKey,
    action.targetUrl,
    action.title,
    action.id
  ].filter(Boolean).join(' ')).includes(workspaceNeedle)
}

function readState() {
  if (!existsSync(statePath)) return {}
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

function writeState(state) {
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, JSON.stringify(state, null, 2))
  renameSync(tempPath, statePath)
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error('invalid_json_body')
    error.statusCode = 400
    throw error
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(body)
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9:/._-]+/g, '-')
}

function loadEnv(paths) {
  const values = { ...process.env }
  for (const path of paths) {
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const index = trimmed.indexOf('=')
      const key = trimmed.slice(0, index).trim()
      let value = trimmed.slice(index + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (!(key in values)) values[key] = value
    }
  }
  return values
}

function log(event, payload = {}) {
  console.log(JSON.stringify({ event, ...payload, at: new Date().toISOString() }))
}
