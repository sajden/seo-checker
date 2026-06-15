#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const inputPath = process.argv[2]
if (!inputPath) throw new Error('Missing JSON input path')
const input = JSON.parse(readFileSync(inputPath, 'utf8'))
const container = process.env.SEO_AGENT_GSC_FIREFOX_CONTAINER || 'seo-agent-gsc-browser-plain'
const command = String(input.command || '').trim()

if (!['doctor', 'open-property', 'inspect-url', 'observe', 'open-url', 'current-url'].includes(command)) throw new Error(`Unsupported command: ${command}`)
const result = await run(command, input)
console.log(JSON.stringify(result, null, 2))

async function run(command, input) {
  const doctor = await runDocker(['ps', '--filter', `name=${container}`, '--filter', 'status=running', '--format', '{{.Names}}']).then((r) => r.stdout.trim()).catch(() => '')
  if (command === 'doctor') {
    const canObserve = doctor ? await observeScreen().then((r) => r.ok).catch(() => false) : false
    return { ok: Boolean(doctor), container, status: doctor ? 'running' : 'not_running', mode: 'firefox_wayland_ui', canObserve }
  }
  if (!doctor) return { ok: false, container, status: 'not_running' }
  if (command === 'observe') return observeScreen()
  if (command === 'open-url') {
    const url = String(input.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, command, error: 'valid_url_required' }
    await openFirefoxUrl(url)
    await sleep(3000)
    return { ok: true, command, opened: url, currentUrl: await readFirefoxCurrentUrl().catch(() => '') }
  }
  if (command === 'current-url') {
    const currentUrl = await readFirefoxCurrentUrl()
    return { ok: true, command, currentUrl }
  }
  assertWorkspaceUrl(input)
  const gscProperty = normalizeGscProperty(String(input.gscProperty || '').trim(), input)
  const targetUrl = String(input.targetUrl || '').trim()
  const propertyUrl = `https://search.google.com/search-console?resource_id=${encodeURIComponent(gscProperty)}`
  await novncNavigate(propertyUrl)
  if (command === 'open-property') return { ok: true, command, opened: propertyUrl }
  await sleep(4500)
  const inspectionRun = await inspectUrlWithRetries(targetUrl)
  const { observation, inspection, attempts } = inspectionRun
  return {
    ok: true,
    command,
    opened: propertyUrl,
    targetUrl,
    status: 'inspection_attempted',
    inspection,
    observation,
    attempts,
    next: inspection.status === 'indexed'
      ? 'URL Inspection result looks indexed. The Discord worker may close the stale indexing action.'
      : 'Verify in the visible Firefox window. Only indexed results are auto-classified right now.'
  }
}

async function inspectUrlWithRetries(targetUrl) {
  const attempts = []
  const strategies = ['top_search_click', 'slash_shortcut', 'sidebar_then_top_search']
  let best = null
  for (const strategy of strategies) {
    await novncInspectUrl(targetUrl, strategy)
    await sleep(4500)
    const observation = await observeScreen().catch((error) => ({ ok: false, error: error.message }))
    const inspection = observation.ok ? analyzeInspectionScreenshot(observation.path) : { status: 'unknown', confidence: 0, reason: 'observation_failed' }
    const attempt = { strategy, status: inspection.status, confidence: inspection.confidence, reason: inspection.reason, observationPath: observation.path || null }
    attempts.push(attempt)
    const score = inspectionScore(inspection)
    if (!best || score > best.score) best = { score, observation, inspection }
    if (inspection.status !== 'unknown' && Number(inspection.confidence || 0) >= 0.75) {
      return { observation, inspection, attempts }
    }
  }
  return { observation: best?.observation || { ok: false, error: 'no_observation' }, inspection: best?.inspection || { status: 'unknown', confidence: 0, reason: 'all_attempts_failed' }, attempts }
}

function normalizeGscProperty(value, input = {}) {
  const raw = String(value || '').trim()
  if (raw.startsWith('sc-domain:')) return raw
  if (/^https?:\/\//i.test(raw)) return raw.replace(/#.*$/, '')
  const host = String(input.workspaceHost || input.siteHost || '').replace(/^sc-domain:/, '').trim()
  if (host) return `https://${host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')}/`
  const targetUrl = String(input.targetUrl || '').trim()
  if (/^https?:\/\//i.test(targetUrl)) {
    const parsed = new URL(targetUrl)
    return `${parsed.protocol}//${parsed.hostname}/`
  }
  throw new Error('Missing GSC property for URL Inspection')
}

function inspectionScore(inspection) {
  const status = inspection?.status || 'unknown'
  const confidence = Number(inspection?.confidence || 0)
  if (status === 'indexed') return 100 + confidence
  if (status === 'not_indexed_or_warning') return 80 + confidence
  return confidence
}

async function novncNavigate(url) {
  await restartFirefoxUrl(url)
  await sleep(6000)
}

async function openFirefoxUrl(url) {
  const script = [
    'export DISPLAY=:1',
    'export XDG_RUNTIME_DIR=/config/.XDG',
    'export WAYLAND_DISPLAY=wayland-1',
    'export MOZ_ENABLE_WAYLAND=1',
    `nohup firefox ${shellQuote(url)} >/tmp/seo-agent-firefox-open.log 2>&1 &`
  ].join('; ')
  await runDocker(['exec', '-u', 'abc', container, 'sh', '-lc', script])
}

async function pasteFirefoxUrl(url) {
  const script = [
    'export XDG_RUNTIME_DIR=/config/.XDG',
    'export WAYLAND_DISPLAY=wayland-1',
    `printf %s ${shellQuote(url)} | wl-copy`,
    'sleep 0.2',
    'wtype -M ctrl -k l -m ctrl',
    'sleep 0.2',
    'wtype -M ctrl -k v -m ctrl',
    'sleep 0.2',
    'wtype -k Return'
  ].join('; ')
  await runDocker(['exec', '-u', 'abc', container, 'sh', '-lc', script])
}

async function restartFirefoxUrl(url) {
  const script = [
    'export DISPLAY=:1',
    'export XDG_RUNTIME_DIR=/config/.XDG',
    'export WAYLAND_DISPLAY=wayland-1',
    'export MOZ_ENABLE_WAYLAND=1',
    'pkill firefox || true',
    'sleep 2',
    `nohup firefox ${shellQuote(url)} >/tmp/seo-agent-firefox-open.log 2>&1 &`
  ].join('; ')
  await runDocker(['exec', '-u', 'abc', container, 'sh', '-lc', script])
}

async function novncInspectUrl(targetUrl, strategy = 'top_search_click') {
  await copyToClipboard(targetUrl)
  const browser = await launchChromium()
  try {
    const page = await openNovncPage(browser)
    await page.keyboard.press('Escape').catch(() => null)
    await page.waitForTimeout(300)
    if (strategy === 'slash_shortcut') {
      await page.keyboard.press('Escape')
      await page.keyboard.press('/')
    } else if (strategy === 'sidebar_then_top_search') {
      await page.mouse.click(100, 360)
      await page.waitForTimeout(1000)
      await page.mouse.click(650, 32)
    } else {
      await page.mouse.click(650, 32)
    }
    await page.waitForTimeout(500)
    await wtypeKeys(['-M', 'ctrl', '-k', 'a', '-m', 'ctrl'])
    await sleep(300)
    await wtypeKeys(['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'])
    await sleep(300)
    await wtypeKeys(['-k', 'Return'])
    await page.waitForTimeout(8000)
  } finally {
    await browser.close()
  }
}

async function readFirefoxCurrentUrl() {
  const script = [
    'export XDG_RUNTIME_DIR=/config/.XDG',
    'export WAYLAND_DISPLAY=wayland-1',
    'wl-copy --clear 2>/dev/null || true',
    'wtype -M ctrl -k l -m ctrl',
    'sleep 0.2',
    'wtype -M ctrl -k c -m ctrl',
    'sleep 0.4',
    'wl-paste'
  ].join('; ')
  const result = await runDocker(['exec', '-u', 'abc', container, 'sh', '-lc', script])
  return result.stdout.trim()
}

async function openNovncPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto('http://127.0.0.1:3007/', { waitUntil: 'networkidle', timeout: 30_000 })
  await page.waitForTimeout(2500)
  return page
}

async function launchChromium() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || await findSystemChrome()
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
}

async function findSystemChrome() {
  const candidates = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  for (const candidate of candidates) {
    try {
      await exec('test', ['-x', candidate])
      return candidate
    } catch {}
  }
  return ''
}

async function observeScreen() {
  cleanupOldObservations()
  const path = `/tmp/gsc-novnc-observe-${Date.now()}.png`
  const browser = await launchChromium()
  try {
    const page = await openNovncPage(browser)
    await page.screenshot({ path, fullPage: false })
    const title = await page.title().catch(() => '')
    const text = await page.locator('body').evaluate((el) => el.innerText.slice(0, 1000)).catch(() => '')
    return { ok: true, path, width: 1280, height: 720, title, textSample: text }
  } finally {
    await browser.close()
  }
}

function analyzeInspectionScreenshot(path) {
  try {
    const image = PNG.sync.read(readFileSync(path))
    const greenPixels = countPixels(image, {
      x1: 360, y1: 280, x2: 500, y2: 410,
      test: (r, g, b) => g >= 115 && r <= 90 && b <= 120 && g > r * 1.6 && g > b * 1.4
    })
    const redOrangePixels = countPixels(image, {
      x1: 360, y1: 280, x2: 500, y2: 410,
      test: (r, g, b) => r >= 150 && g >= 70 && g <= 180 && b <= 90
    })
    const urlInspectionChrome = countPixels(image, {
      x1: 15, y1: 330, x2: 280, y2: 385,
      test: (r, g, b) => r >= 150 && g >= 205 && b >= 235
    })
    if (greenPixels > 250 && urlInspectionChrome > 500) {
      return {
        status: 'indexed',
        confidence: Math.min(0.99, 0.75 + greenPixels / 4000),
        reason: 'green_status_icon_detected_in_url_inspection',
        evidence: { greenPixels, redOrangePixels, urlInspectionChrome }
      }
    }
    if (redOrangePixels > 250 && urlInspectionChrome > 500) {
      return {
        status: 'not_indexed_or_warning',
        confidence: Math.min(0.85, 0.55 + redOrangePixels / 5000),
        reason: 'warning_status_icon_detected_in_url_inspection',
        evidence: { greenPixels, redOrangePixels, urlInspectionChrome }
      }
    }
    return {
      status: 'unknown',
      confidence: 0.25,
      reason: 'inspection_status_not_confident',
      evidence: { greenPixels, redOrangePixels, urlInspectionChrome }
    }
  } catch (error) {
    return { status: 'unknown', confidence: 0, reason: `screenshot_analysis_failed:${error?.message || String(error)}` }
  }
}

function countPixels(image, { x1, y1, x2, y2, test }) {
  let count = 0
  const minX = Math.max(0, x1)
  const maxX = Math.min(image.width, x2)
  const minY = Math.max(0, y1)
  const maxY = Math.min(image.height, y2)
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const idx = (image.width * y + x) << 2
      if (test(image.data[idx], image.data[idx + 1], image.data[idx + 2], image.data[idx + 3])) count++
    }
  }
  return count
}

function cleanupOldObservations() {
  try {
    const files = readdirSync('/tmp')
      .filter((name) => /^gsc-novnc-observe-\d+\.png$/.test(name))
      .map((name) => ({ name, path: `/tmp/${name}`, mtimeMs: statSync(`/tmp/${name}`).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const keep = new Set(files.slice(0, 12).map((file) => file.name))
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const file of files) {
      if (!keep.has(file.name) || file.mtimeMs < cutoff) unlinkSync(file.path)
    }
  } catch {}
}


async function focusUrlInspectionBox(targetUrl) {
  // GSC's top "Inspect any URL" box is a page-level control. The most reliable keyboard-only path
  // observed in noVNC is to let the page load, clear transient focus, use the app search shortcut,
  // paste the URL, then press Enter. This is intentionally conservative: it starts inspection but
  // does not click Request indexing yet.
  await wtypeKeys(['-k', 'Escape'])
  await sleep(300)
  await copyToClipboard(targetUrl)
  await wtypeText('/')
  await sleep(300)
  await wtypeKeys(['-M', 'ctrl', 'v', '-m', 'ctrl'])
  await sleep(300)
  await wtypeKeys(['-k', 'Return'])
}

async function copyToClipboard(text) {
  await runDocker(['exec', '-u', 'abc', container, 'sh', '-lc', `export XDG_RUNTIME_DIR=/config/.XDG; export WAYLAND_DISPLAY=wayland-1; printf %s ${shellQuote(text)} | wl-copy`])
}

async function wtypeUrl(url) {
  await wtypeKeys(['-M', 'ctrl', 'l', '-m', 'ctrl'])
  await wtypeText(url)
  await wtypeKeys(['-k', 'Return'])
}

async function wtypeText(text) {
  await runDocker(['exec', '-u', 'abc', container, 'sh', '-lc', `export XDG_RUNTIME_DIR=/config/.XDG; export WAYLAND_DISPLAY=wayland-1; wtype ${shellQuote(text)}`])
}

async function wtypeKeys(args) {
  await runDocker(['exec', '-u', 'abc', container, 'sh', '-lc', `export XDG_RUNTIME_DIR=/config/.XDG; export WAYLAND_DISPLAY=wayland-1; wtype ${args.map(shellQuote).join(' ')}`])
}

function assertWorkspaceUrl(input) {
  const targetUrl = String(input.targetUrl || '')
  const workspaceHost = String(input.workspaceHost || input.siteHost || '').replace(/^sc-domain:/, '')
  if (targetUrl) {
    if (!/^https:\/\//i.test(targetUrl)) throw new Error('targetUrl must be an https URL')
    const host = new URL(targetUrl).hostname.replace(/^www\./, '')
    if (workspaceHost && host !== workspaceHost.replace(/^www\./, '')) throw new Error(`targetUrl host ${host} does not match workspace host ${workspaceHost}`)
  }
}

function runDocker(args) {
  return exec('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
}
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
