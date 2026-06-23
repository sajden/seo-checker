#!/usr/bin/env node
import http from 'node:http'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const env = loadEnv(['/opt/ai-dashboard/apps/seo-runtime/.env', '/home/deploy/seo-agent-discord/.env'])
const host = env.SEO_RUNTIME_HOST || '127.0.0.1'
const port = Number(env.SEO_RUNTIME_PORT || '1460')
const statePath = env.SEO_RUNTIME_STATE_PATH || '/home/deploy/seo-agent-discord/state/state.json'
const runtimeKey = 'seo-agent'

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
  const executeMatch = url.pathname.match(/^\/seo\/actions\/([^/]+)\/execute$/)
  if (request.method === 'POST' && executeMatch) {
    const actionId = decodeURIComponent(executeMatch[1])
    const body = await readJsonBody(request)
    const result = executeAction(actionId, body)
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
