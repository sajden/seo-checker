#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const inputPath = process.argv[2]
if (!inputPath) throw new Error('Missing JSON input path')

const env = loadEnv(['/home/deploy/.hermes/.env', '/home/deploy/seo-agent-discord/.env'])
const stateDir = '/home/deploy/seo-agent-discord/state'
const input = JSON.parse(readFileSync(inputPath, 'utf8'))
const command = String(input.command || '').trim()

if (!['doctor', 'doctor-shallow', 'inspect-url'].includes(command)) throw new Error(`Unsupported command: ${command}`)

const result = await run(command, input)
console.log(JSON.stringify(result, null, 2))

async function run(command, input) {
  const config = loadConfig()
  if (command === 'doctor') {
    const missing = [
      !config.clientId ? 'GSC_CLIENT_ID or GOOGLE_CLIENT_ID' : '',
      !config.clientSecret ? 'GSC_CLIENT_SECRET or GOOGLE_CLIENT_SECRET' : '',
      !config.refreshToken ? 'GSC_REFRESH_TOKEN or state/gsc-refresh-token.txt' : ''
    ].filter(Boolean)
    if (missing.length) {
      return {
        ok: false,
        command,
        status: 'missing_oauth_config',
        missing
      }
    }
    try {
      await refreshAccessToken(config)
      return {
        ok: true,
        command,
        status: 'ready',
        missing: []
      }
    } catch (error) {
      return {
        ok: false,
        command,
        status: 'invalid_refresh_token',
        error: error?.message || String(error),
        missing: []
      }
    }
  }
  if (command === 'doctor-shallow') {
    return {
      ok: Boolean(config.clientId && config.clientSecret && config.refreshToken),
      command,
      status: config.clientId && config.clientSecret && config.refreshToken ? 'ready' : 'missing_oauth_config',
      missing: [
        !config.clientId ? 'GSC_CLIENT_ID or GOOGLE_CLIENT_ID' : '',
        !config.clientSecret ? 'GSC_CLIENT_SECRET or GOOGLE_CLIENT_SECRET' : '',
        !config.refreshToken ? 'GSC_REFRESH_TOKEN or state/gsc-refresh-token.txt' : ''
      ].filter(Boolean)
    }
  }
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    return {
      ok: false,
      command,
      status: 'missing_oauth_config',
      error: 'GSC URL Inspection API requires OAuth client id, client secret and refresh token'
    }
  }

  const targetUrl = String(input.targetUrl || '').trim()
  if (!/^https:\/\//i.test(targetUrl)) return { ok: false, command, status: 'invalid_target_url', error: 'targetUrl must be an https URL' }
  const siteUrl = normalizeSiteUrl(String(input.gscProperty || '').trim(), input)
  const accessToken = await refreshAccessToken(config)
  const response = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      inspectionUrl: targetUrl,
      siteUrl,
      languageCode: String(input.languageCode || 'sv-SE')
    })
  })
  const payload = await response.json().catch(async () => ({ raw: await response.text().catch(() => '') }))
  if (!response.ok) {
    return {
      ok: false,
      command,
      status: `google_api_${response.status}`,
      error: payload?.error?.message || payload?.error_description || payload?.error || `google_api_${response.status}`,
      siteUrl,
      targetUrl,
      payload: redactPayload(payload)
    }
  }
  const inspection = normalizeInspection(payload)
  return {
    ok: true,
    command,
    status: 'inspection_complete',
    source: 'google_url_inspection_api',
    siteUrl,
    targetUrl,
    inspection,
    raw: payload
  }
}

function loadConfig() {
  return {
    clientId: env.GSC_CLIENT_ID || env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GSC_CLIENT_SECRET || env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: env.GSC_REFRESH_TOKEN || env.GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN || readOptional(join(stateDir, 'gsc-refresh-token.txt'))
  }
}

async function refreshAccessToken(config) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token'
    })
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || `google_oauth_${response.status}`)
  return String(payload.access_token)
}

function normalizeSiteUrl(value, input = {}) {
  const raw = String(value || '').trim()
  if (raw.startsWith('sc-domain:')) return raw
  if (/^https?:\/\//i.test(raw)) return raw.replace(/#.*$/, '')
  const host = String(input.workspaceHost || input.siteHost || '').replace(/^sc-domain:/, '').trim()
  if (host) return `sc-domain:${host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')}`
  const targetUrl = String(input.targetUrl || '').trim()
  if (/^https?:\/\//i.test(targetUrl)) return `sc-domain:${new URL(targetUrl).hostname.replace(/^www\./, '')}`
  throw new Error('Missing GSC property for URL Inspection API')
}

function normalizeInspection(payload) {
  const result = payload?.inspectionResult || {}
  const indexStatus = result.indexStatusResult || {}
  const verdict = String(indexStatus.verdict || '').toUpperCase()
  const coverageState = String(indexStatus.coverageState || '')
  const robotsTxtState = String(indexStatus.robotsTxtState || '')
  const indexingState = String(indexStatus.indexingState || '')
  const pageFetchState = String(indexStatus.pageFetchState || '')
  const googleCanonical = String(indexStatus.googleCanonical || '')
  const userCanonical = String(indexStatus.userCanonical || '')
  const status = verdict === 'PASS'
    ? 'indexed'
    : verdict === 'FAIL' || verdict === 'PARTIAL'
      ? 'not_indexed_or_warning'
      : 'unknown'
  const reason = [
    verdict ? `verdict_${verdict.toLowerCase()}` : '',
    coverageState ? `coverage_${slugify(coverageState)}` : '',
    pageFetchState ? `fetch_${slugify(pageFetchState)}` : ''
  ].filter(Boolean).join(':') || 'url_inspection_api_result'
  return {
    status,
    confidence: status === 'unknown' ? 0.55 : 0.95,
    reason,
    verdict,
    coverageState,
    robotsTxtState,
    indexingState,
    pageFetchState,
    googleCanonical,
    userCanonical,
    lastCrawlTime: indexStatus.lastCrawlTime || '',
    sitemap: Array.isArray(indexStatus.sitemap) ? indexStatus.sitemap : [],
    referringUrls: Array.isArray(indexStatus.referringUrls) ? indexStatus.referringUrls : []
  }
}

function redactPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  return JSON.parse(JSON.stringify(payload, (key, value) => /token|secret|authorization/i.test(key) ? '[redacted]' : value))
}

function readOptional(path) {
  try {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
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

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}
