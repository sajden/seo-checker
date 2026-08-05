#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const env = loadEnv(['/home/deploy/.hermes/.env', '/home/deploy/seo-agent-discord/.env'])
const discordToken = env.DISCORD_BOT_TOKEN || ''
const discordChannelId = env.SEO_AGENT_ALERT_CHANNEL_ID || env.DISCORD_CHANNEL_ID || ''
const workerStatePath = env.SEO_AGENT_STATE_PATH || '/opt/ai-dashboard/apps/seo-agent-discord/state/state.json'
const alertStatePath = env.SEO_AGENT_CHAIN_HEALTH_STATE_PATH || '/opt/ai-dashboard/apps/seo-agent-discord/state/chain-health-alerts.json'
const repoHealthLog = env.SEO_AGENT_REPO_HEALTH_LOG || '/mnt/HC_Volume_105954589/deploy-storage/logs/seo-agent-repo-health.jsonl'
const releaseManifestPath = env.SEO_AGENT_RELEASE_MANIFEST || '/opt/ai-dashboard/apps/seo-agent-discord/.release.json'
const runtimeUrl = (env.SEO_RUNTIME_URL || 'http://127.0.0.1:1460').replace(/\/$/, '')
const workerStaleMs = Number(env.SEO_AGENT_CHAIN_WORKER_STALE_MS || 15 * 60 * 1000)
const repoHealthStaleMs = Number(env.SEO_AGENT_CHAIN_REPO_HEALTH_STALE_MS || 45 * 60 * 1000)
const repeatAlertMs = Number(env.SEO_AGENT_CHAIN_ALERT_REPEAT_MS || 6 * 60 * 60 * 1000)
const dryRun = env.SEO_AGENT_CHAIN_HEALTH_DRY_RUN === 'true' || process.argv.includes('--dry-run')

const previous = readJson(alertStatePath, {})
const issues = []

await checkService('seo-agent-discord.service', 'discord-worker')
await checkService('seo-runtime.service', 'seo-runtime-service')
await checkOneshotService('seo-agent-auto-deploy.service', 'seo-auto-deploy')
await checkRuntimeHealth()
await checkCriticalLiveExperiences()
checkReleaseIntegrity()
checkWorkerState()
checkRepoHealth()
checkStaleCodeWork()

const now = new Date()
const issueIds = issues.map((issue) => issue.id).sort()
const previousIds = Array.isArray(previous.activeIssueIds) ? previous.activeIssueIds.slice().sort() : []
const changed = JSON.stringify(issueIds) !== JSON.stringify(previousIds)
const lastAlertAt = Date.parse(previous.lastAlertAt || '')
const shouldRepeat = !Number.isFinite(lastAlertAt) || now.getTime() - lastAlertAt >= repeatAlertMs

if (issues.length && (changed || shouldRepeat)) {
  await notify([
    '**SEO-kedjan behöver tillsyn**',
    ...issues.map((issue) => `- **${issue.label}:** ${issue.detail}`),
    '',
    'Samma felläge larmas inte igen förrän läget ändras eller sex timmar har gått.'
  ].join('\n'))
  previous.lastAlertAt = now.toISOString()
}

if (!issues.length && previousIds.length) {
  await notify([
    '**SEO-kedjan är återställd**',
    `Tidigare fel är borta: ${previousIds.join(', ')}.`,
    'Datainsamling, agentruntime och repo-kontroller rapporterar normalt igen.'
  ].join('\n'))
  previous.lastRecoveryAt = now.toISOString()
}

const nextState = {
  ...previous,
  checkedAt: now.toISOString(),
  status: issues.length ? 'degraded' : 'healthy',
  activeIssueIds: issueIds,
  activeIssues: issues
}
writeJson(alertStatePath, nextState)
console.log(JSON.stringify(nextState, null, 2))
if (issues.length) process.exitCode = 1

async function checkService(unit, id) {
  try {
    const result = await exec('systemctl', ['--user', 'is-active', unit], { timeout: 10_000 })
    if (result.stdout.trim() !== 'active') addIssue(id, unit, `systemd-status är ${result.stdout.trim() || 'okänd'}.`)
  } catch (error) {
    addIssue(id, unit, `systemd-tjänsten är inte aktiv (${commandError(error)}).`)
  }
}

async function checkOneshotService(unit, id) {
  try {
    const result = await exec('systemctl', ['--user', 'show', unit, '-p', 'LoadState', '-p', 'Result'], { timeout: 10_000 })
    const properties = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map((line) => line.split(/=(.*)/s).slice(0, 2)))
    const loadState = properties.LoadState || ''
    const serviceResult = properties.Result || ''
    if (loadState !== 'loaded') addIssue(id, unit, 'systemd-enheten är inte installerad.')
    else if (serviceResult && serviceResult !== 'success') addIssue(id, unit, `senaste deployförsöket slutade med ${serviceResult}.`)
  } catch (error) {
    addIssue(id, unit, `deploystatus kunde inte läsas (${commandError(error)}).`)
  }
}

function checkReleaseIntegrity() {
  const release = readJson(releaseManifestPath, null)
  if (!release?.commit || !release?.files || typeof release.files !== 'object') {
    addIssue('release-manifest-missing', 'SEO-release', 'release-manifest saknas eller är ogiltigt.')
    return
  }
  const drift = []
  for (const [path, expected] of Object.entries(release.files)) {
    if (!existsSync(path)) {
      drift.push(`${path}: saknas`)
      continue
    }
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (actual !== expected) drift.push(`${path}: checksum skiljer sig`)
  }
  if (drift.length) addIssue('release-code-drift', 'SEO-release', `Installerad kod avviker från ${String(release.commit).slice(0, 12)}: ${drift.slice(0, 5).join('; ')}`)
}

async function checkRuntimeHealth() {
  try {
    const response = await fetch(`${runtimeUrl}/healthz`, { signal: AbortSignal.timeout(8_000) })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) addIssue('seo-runtime-health', 'SEO Runtime API', `healthz svarade ${response.status} utan ok-status.`)
  } catch (error) {
    addIssue('seo-runtime-health', 'SEO Runtime API', `healthz kunde inte läsas (${error?.message || String(error)}).`)
  }
}

async function checkCriticalLiveExperiences() {
  if (!hasLiveBrowserCapacity()) return
  const checks = [
    {
      id: 'parkeringspolaren-map',
      label: 'Parkeringspolaren karta',
      url: 'https://parkeringspolaren.se/sv/mc-parkering-jonkoping',
      readySelector: '.leaflet-container',
      assetSelector: 'img.leaflet-tile',
      viewports: [
        { name: 'desktop', width: 1365, height: 768 },
        { name: 'mobil', width: 390, height: 844 }
      ]
    }
  ]

  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (error) {
    addIssue('live-browser-unavailable', 'Visuell produktionskontroll', `Playwright kunde inte laddas (${error?.code || error?.message || error}).`)
    return
  }

  let browser
  try {
    browser = await chromium.launch({
      executablePath: env.SEO_AGENT_CHROME_PATH || '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    })
    for (const check of checks) {
      for (const viewport of check.viewports) {
        await checkLiveExperience(browser, check, viewport)
      }
    }
  } catch (error) {
    addIssue('live-browser-failed', 'Visuell produktionskontroll', `Chrome-kontrollen kunde inte köras (${error?.message || String(error)}).`)
  } finally {
    await browser?.close().catch(() => {})
  }
}

function hasLiveBrowserCapacity() {
  const heavyWorkLock = '/home/deploy/seo-agent-workspaces/.locks/seo-heavy-work-global.json'
  const owner = readJson(heavyWorkLock, null)
  if (owner?.pid) {
    try {
      process.kill(Number(owner.pid), 0)
      return false
    } catch {}
  }
  try {
    const availableKb = Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1] || 0)
    if (availableKb && availableKb < 700 * 1024) return false
  } catch {}
  return true
}

async function checkLiveExperience(browser, check, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
  const page = await context.newPage()
  const failures = []
  page.on('requestfailed', (request) => {
    if (/tile\.openstreetmap\.org/i.test(request.url())) failures.push(`${request.failure()?.errorText || 'request_failed'}: ${request.url()}`)
  })
  try {
    const response = await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    if (!response?.ok()) throw new Error(`HTTP ${response?.status() || 'utan svar'}`)
    const container = page.locator(check.readySelector).first()
    await container.scrollIntoViewIfNeeded({ timeout: 15_000 })
    await container.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForFunction((selector) => {
      const assets = [...document.querySelectorAll(selector)]
      return assets.some((asset) => asset instanceof HTMLImageElement && asset.complete && asset.naturalWidth > 0)
    }, check.assetSelector, { timeout: 15_000 })
    if (failures.length) throw new Error(failures[0])
  } catch (error) {
    addIssue(
      `live-${check.id}-${viewport.name}`,
      check.label,
      `${viewport.name} misslyckades på ${check.url}: ${String(error?.message || error).split('\n')[0].slice(0, 500)}`
    )
  } finally {
    await context.close().catch(() => {})
  }
}

function checkWorkerState() {
  if (!existsSync(workerStatePath)) {
    addIssue('worker-state-missing', 'SEO-worker', 'state.json saknas; workern kan inte bevisa att loopen kör.')
    return
  }
  const ageMs = Date.now() - statSync(workerStatePath).mtimeMs
  if (ageMs > workerStaleMs) addIssue('worker-state-stale', 'SEO-worker', `state.json har inte uppdaterats på ${formatDuration(ageMs)} trots att tjänsten är aktiv.`)
}

function checkRepoHealth() {
  if (!existsSync(repoHealthLog)) {
    addIssue('repo-health-missing', 'Repo-kontroll', 'Ingen repo-health-logg finns.')
    return
  }
  const latest = readLastJsonLine(repoHealthLog)
  const checkedAt = Date.parse(latest?.at || '')
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > repoHealthStaleMs) {
    addIssue('repo-health-stale', 'Repo-kontroll', 'Ingen färsk kontroll av checkout och push-behörighet finns inom 45 minuter.')
    return
  }
  const failed = Array.isArray(latest.results) ? latest.results.filter((item) => item?.ok !== true) : []
  if (failed.length) {
    addIssue('repo-health-failed', 'Repo-kontroll', failed.map((item) => `${item.repo}: ${item.status || item.error || 'fel'}`).join('; ').slice(0, 700))
  }
}

function checkStaleCodeWork() {
  const state = readJson(workerStatePath, null)
  if (!state) return
  const running = state.codeActionRunning
  if (running) {
    const startedAt = Date.parse(running.startedAt || running.at || '')
    if (Number.isFinite(startedAt) && Date.now() - startedAt > 2 * 60 * 60 * 1000) {
      addIssue('code-action-stalled', 'SEO-kodjobb', `Kodjobbet ${running.actionId || running.id || 'utan id'} har varit aktivt i mer än två timmar.`)
    }
  }
  const stalePromotions = Object.entries(state.codeActionResults || {}).filter(([, result]) => {
    if (result?.status !== 'promotion_running') return false
    const startedAt = Date.parse(result.promotionStartedAt || result.operatorApprovedAt || result.reviewReadyAt || '')
    return Number.isFinite(startedAt) && Date.now() - startedAt > 30 * 60 * 1000
  })
  if (stalePromotions.length) addIssue('promotion-stalled', 'SEO-publicering', `${stalePromotions.length} godkänd publicering har varit låst i mer än 30 minuter.`)
}

function addIssue(id, label, detail) {
  issues.push({ id, label, detail: String(detail).slice(0, 800) })
}

async function notify(content) {
  if (dryRun) {
    console.log(`[dry-run] ${content}`)
    return
  }
  if (!discordToken || !discordChannelId) throw new Error('discord_alert_credentials_missing')
  const response = await fetch(`https://discord.com/api/v10/channels/${discordChannelId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${discordToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1990), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error(`discord_alert_${response.status}:${(await response.text()).slice(0, 300)}`)
}

function loadEnv(paths) {
  const result = { ...process.env }
  for (const path of paths) {
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (!match || result[match[1]]) continue
      result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return result
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function readLastJsonLine(path) {
  try {
    const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/)
    return JSON.parse(lines.at(-1) || '{}')
  } catch { return null }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000)
  return minutes < 120 ? `${minutes} minuter` : `${Math.round(minutes / 60)} timmar`
}

function commandError(error) {
  return String(error?.stdout || error?.stderr || error?.message || error).trim().slice(0, 300)
}
