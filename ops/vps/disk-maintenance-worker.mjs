#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const clean = args.has('--clean')
const dryRun = args.has('--dry-run') || !clean
const aggressiveFlag = args.has('--aggressive')
const rootPath = '/'
const now = Date.now()
const reportDir = '/home/deploy/disk-maintenance/reports'
const env = loadEnv(['/home/deploy/.hermes/.env', '/home/deploy/seo-agent-discord/.env', '/home/deploy/disk-maintenance/.env'])
const warningPct = Number(env.DISK_MAINTENANCE_WARNING_PCT || '90')
const aggressivePct = Number(env.DISK_MAINTENANCE_AGGRESSIVE_PCT || '96')
const discordChannelId = env.DISK_MAINTENANCE_DISCORD_CHANNEL_ID || env.DISCORD_CHANNEL_ID || ''

mkdirSync(reportDir, { recursive: true })
const before = diskUsage(rootPath)
const plan = []

addTmpCleanup(plan)
addNpmCleanup(plan)
addGenericCacheCleanup(plan)
addAgentStateCleanup(plan)
addBuildArtifactCleanup(plan, aggressiveFlag || before.usedPct >= aggressivePct)
addDockerSafeCleanup(plan, before.usedPct >= warningPct)

let freed = 0
const actions = []
for (const item of plan) {
  const size = pathSize(item.path)
  if (!size && item.type !== 'command') continue
  if (item.type === 'command') {
    actions.push({ ...item, size: 0, status: dryRun ? 'planned' : runCommand(item) })
    continue
  }
  if (!dryRun) removePath(item.path)
  freed += size
  actions.push({ ...item, size, status: dryRun ? 'planned' : 'removed' })
}

const after = diskUsage(rootPath)
const report = {
  at: new Date().toISOString(),
  mode: dryRun ? 'dry-run' : 'clean',
  before,
  after,
  plannedCount: plan.length,
  actions,
  freedBytesApprox: freed,
}
appendFileSync(join(reportDir, 'disk-maintenance.jsonl'), `${JSON.stringify(report)}\n`)
console.log(JSON.stringify(report, null, 2))

if (!dryRun && (before.usedPct >= warningPct || after.usedPct >= warningPct || freed > 100 * 1024 * 1024)) {
  await notifyDiscord(report).catch(() => null)
}

function addTmpCleanup(plan) {
  addGlobFiles(plan, '/tmp', /^gsc-novnc-observe-\d+\.png$/, { olderThanMs: 24 * 60 * 60 * 1000, keepNewest: 20, reason: 'old_gsc_observation' })
  addGlobFiles(plan, '/tmp', /^(playwright-|v8-compile-cache-|puppeteer_|tmp-)/, { olderThanMs: 24 * 60 * 60 * 1000, keepNewest: 0, reason: 'old_tmp_cache' })
  addGlobFiles(plan, '/tmp', /^tiktok-.*\.(png|json|log)$/, { olderThanMs: 24 * 60 * 60 * 1000, keepNewest: 6, reason: 'old_debug_artifact' })
}

function addNpmCleanup(plan) {
  addIfExists(plan, '/home/deploy/.npm/_logs', 'npm_logs')
  addIfExists(plan, '/home/deploy/.npm/_cacache', 'npm_cache')
  addGlobFiles(plan, '/home/deploy/.npm/_npx', /.*/, { olderThanMs: 7 * 24 * 60 * 60 * 1000, keepNewest: 1, reason: 'old_npx_cache' })
}

function addGenericCacheCleanup(plan) {
  addIfExists(plan, '/home/deploy/.cache/pip', 'pip_cache')
  addIfExists(plan, '/home/deploy/.cache/pnpm', 'pnpm_cache')
  addIfExists(plan, '/home/deploy/.cache/yarn', 'yarn_cache')
  addIfExists(plan, '/home/deploy/.cache/go-build', 'go_build_cache')
  addIfExists(plan, '/home/deploy/.cache/node-gyp', 'node_gyp_cache')
  addGlobFiles(plan, '/home/deploy/.cache/ms-playwright', /^\.links$/, { olderThanMs: 0, keepNewest: 0, reason: 'playwright_links_cache' })
}

function addAgentStateCleanup(plan) {
  addGlobFiles(plan, '/home/deploy/seo-agent-discord/state/codex-prompts', /\.md$/, { olderThanMs: 14 * 24 * 60 * 60 * 1000, keepNewest: 100, reason: 'old_codex_prompt' })
  addGlobFiles(plan, '/home/deploy/seo-agent-discord/state', /^gsc-.*\.(png|json)$/, { olderThanMs: 7 * 24 * 60 * 60 * 1000, keepNewest: 20, reason: 'old_gsc_state_artifact' })
  addGlobFiles(plan, '/home/deploy/seo-agent-discord', /^worker\.mjs\.bak-/, { olderThanMs: 14 * 24 * 60 * 60 * 1000, keepNewest: 8, reason: 'old_worker_backup' })
}

function addBuildArtifactCleanup(plan, aggressive) {
  const roots = ['/home/deploy/seo-agent-workspaces']
  for (const root of roots) {
    for (const dir of findDirs(root, ['.next', '.turbo', 'dist', 'build'], 4)) {
      if (dir.endsWith('/node_modules/.bin')) continue
      if (aggressive || dir.endsWith('/.next/cache') || dir.endsWith('/.turbo')) plan.push({ type: 'path', path: dir, reason: aggressive ? 'aggressive_build_artifact' : 'build_cache' })
    }
  }
}

function addDockerSafeCleanup(plan, enabled) {
  if (!enabled) return
  plan.push({ type: 'command', cmd: 'docker', args: ['container', 'prune', '-f'], reason: 'stopped_containers_only' })
  plan.push({ type: 'command', cmd: 'docker', args: ['image', 'prune', '-f'], reason: 'dangling_images_only' })
  plan.push({ type: 'command', cmd: 'docker', args: ['builder', 'prune', '-f'], reason: 'docker_build_cache_only' })
}

function addIfExists(plan, path, reason) {
  if (existsSync(path)) plan.push({ type: 'path', path, reason })
}

function addGlobFiles(plan, dir, pattern, { olderThanMs, keepNewest, reason }) {
  if (!existsSync(dir)) return
  let entries = []
  try {
    entries = readdirSync(dir).filter((name) => pattern.test(name)).map((name) => {
      const path = join(dir, name)
      const stat = statSync(path)
      return { path, mtimeMs: stat.mtimeMs }
    }).sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch { return }
  const keep = new Set(entries.slice(0, keepNewest).map((entry) => entry.path))
  for (const entry of entries) {
    if (keep.has(entry.path)) continue
    if (olderThanMs && now - entry.mtimeMs < olderThanMs) continue
    plan.push({ type: 'path', path: entry.path, reason })
  }
}

function findDirs(root, names, maxDepth) {
  const found = []
  if (!existsSync(root) || maxDepth < 0) return found
  walk(root, 0)
  return found
  function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (names.includes(entry.name)) {
        found.push(path)
        continue
      }
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(path, depth + 1)
    }
  }
}

function diskUsage(path) {
  const output = execFileSync('df', ['-B1', path], { encoding: 'utf8' }).trim().split('\n').pop().trim().split(/\s+/)
  const size = Number(output[1]); const used = Number(output[2]); const avail = Number(output[3])
  return { path, size, used, avail, usedPct: Math.round((used / size) * 1000) / 10 }
}

function pathSize(path) {
  if (!existsSync(path)) return 0
  try {
    const out = execFileSync('du', ['-sb', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/)[0]
    return Number(out) || 0
  } catch { return 0 }
}

function removePath(path) {
  rmSync(path, { recursive: true, force: true })
}

function runCommand(item) {
  try {
    execFileSync(item.cmd, item.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60 * 1000 })
    return 'ran'
  } catch (error) {
    return `failed:${error?.message || String(error)}`
  }
}

function loadEnv(files) {
  const out = {}
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (!match) continue
      out[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return out
}

async function notifyDiscord(report) {
  if (!env.DISCORD_BOT_TOKEN || !discordChannelId) return
  const mb = (value) => Math.round(value / 1024 / 1024)
  const content = [
    'Disk maintenance körd på VPS.',
    `Root: ${report.before.usedPct}% -> ${report.after.usedPct}% (${Math.round(report.after.avail / 1024 / 1024)} MB ledigt).`,
    `Rensat approx: ${mb(report.freedBytesApprox)} MB.`,
    `Actions: ${report.actions.length}.`,
    report.after.usedPct >= warningPct ? 'Varning: root-disken är fortfarande hög. Flytta Docker/agentdata till extradisken.' : ''
  ].filter(Boolean).join('\n')
  await fetch(`https://discord.com/api/v10/channels/${discordChannelId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1900) })
  })
}
