#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { acquireHeavyWorkCapacity } from './workload-capacity.mjs'

const exec = promisify(execFile)
const node22Bin = '/home/deploy/.local/node22/node_modules/node/bin'
const runnerEnv = {
  ...process.env,
  PATH: `${existsSync(node22Bin) ? `${node22Bin}:` : ''}/home/deploy/.npm-global/bin:/home/deploy/.local/bin:${process.env.PATH || ''}`
}
const workspaceRoot = '/home/deploy/seo-agent-workspaces'
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const repoFullName = String(input.repoFullName || '').trim()
const repoName = repoFullName.split('/')[1]
const baseBranch = safeBranch(input.baseBranch || input.branch || 'main')
const deliveryBranch = safeBranch(input.deliveryBranch || '')
const expectedCommit = String(input.commit || '').trim()
const targetUrl = String(input.targetUrl || input.reviewContext?.targetUrl || '').trim()
const dryRun = input.dryRun === true

if (!/^sajden\/[A-Za-z0-9._-]+$/.test(repoFullName) || !repoName) throw new Error('Invalid review repo')
if (!deliveryBranch.startsWith('seo-agent/')) throw new Error('Invalid review branch')
if (!/^[0-9a-f]{7,40}$/i.test(expectedCommit)) throw new Error('Invalid review commit')

const repoDir = join(workspaceRoot, repoName)
if (!existsSync(join(repoDir, '.git'))) throw new Error(`Missing repo checkout: ${repoDir}`)
const promotionCapacity = await acquireHeavyWorkCapacity({
  actionId: input.actionId || expectedCommit,
  purpose: 'review_promotion'
})
const lock = acquireRepoLock(repoName, input.actionId || expectedCommit)
process.on('exit', () => {
  lock.release()
  promotionCapacity.release()
})

let pushed = false
let deployedBeforePush = false
try {
  await assertClean(repoDir)
  await run('git', ['fetch', 'origin', baseBranch, deliveryBranch], repoDir)
  const reviewedCommit = (await run('git', ['rev-parse', `origin/${deliveryBranch}`], repoDir)).stdout.trim()
  if (!reviewedCommit.startsWith(expectedCommit)) {
    throw new Error(`Review branch moved: expected ${expectedCommit}, got ${reviewedCommit.slice(0, 12)}`)
  }
  const diff = await run('git', ['diff', '--stat', `origin/${baseBranch}...origin/${deliveryBranch}`], repoDir)
  if (!diff.stdout.trim()) throw new Error('Review branch has no diff against main')
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, repoFullName, baseBranch, deliveryBranch, reviewedCommit, diffStat: diff.stdout }))
    process.exit(0)
  }

  const fingerprints = await reviewFingerprints(repoDir, baseBranch, deliveryBranch)
  await run('git', ['checkout', '-B', baseBranch, `origin/${baseBranch}`], repoDir)
  await run('git', ['cherry-pick', reviewedCommit], repoDir)
  const promotedCommit = (await run('git', ['rev-parse', 'HEAD'], repoDir)).stdout.trim()
  await runBestBuild(repoDir)
  const configuredDeploy = hasConfiguredProductionDeploy(repoDir)
  if (configuredDeploy) {
    await runConfiguredProductionDeploy(repoDir)
    deployedBeforePush = true
  }
  let verification = configuredDeploy && targetUrl
    ? await verifyLiveTarget(targetUrl, fingerprints)
    : { ok: true, status: null, matchedFingerprint: null, note: configuredDeploy ? 'no_target_url' : 'awaiting_main_push' }
  if (configuredDeploy && !verification.ok) {
    throw new Error(`Production verification failed before main push: ${verification.error || verification.status || 'new content not visible'}`)
  }
  if (configuredDeploy) {
    const experienceVerification = await verifyCriticalProductionExperience(repoFullName)
    if (!experienceVerification.ok) {
      throw new Error(`Critical production experience failed before main push: ${experienceVerification.error}`)
    }
    verification = { ...verification, criticalExperience: experienceVerification }
  }
  await run('git', ['push', 'origin', `HEAD:${baseBranch}`], repoDir)
  pushed = true
  await run('git', ['fetch', 'origin', baseBranch], repoDir)
  await run('git', ['merge-base', '--is-ancestor', promotedCommit, `origin/${baseBranch}`], repoDir)

  if (!configuredDeploy) {
    verification = targetUrl
      ? await verifyLiveTarget(targetUrl, fingerprints)
      : { ok: true, status: null, matchedFingerprint: null, note: 'no_target_url' }
  }

  console.log(JSON.stringify({
    ok: true,
    repoFullName,
    baseBranch,
    deliveryBranch,
    commit: promotedCommit.slice(0, 12),
    reviewCommit: reviewedCommit,
    reviewedCommit,
    promotedCommit,
    diffStat: diff.stdout,
    targetUrl,
    verification,
    deploymentVerificationPending: !verification.ok,
    mergedToMain: true,
    pushedToMain: true
  }))
} catch (error) {
  if (!pushed) {
    if (deployedBeforePush) {
      await restoreProductionFromMain(repoDir, baseBranch).catch(() => null)
    }
    await run('git', ['merge', '--abort'], repoDir).catch(() => null)
    await run('git', ['cherry-pick', '--abort'], repoDir).catch(() => null)
    await run('git', ['checkout', '-B', baseBranch, `origin/${baseBranch}`], repoDir).catch(() => null)
  }
  console.error(JSON.stringify({ ok: false, pushedToMain: pushed, error: error?.message || String(error) }))
  process.exitCode = 1
} finally {
  lock.release()
  promotionCapacity.release()
}

function safeBranch(value) {
  const branch = String(value || '').trim()
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) throw new Error('Invalid branch')
  return branch
}

function acquireRepoLock(name, actionId) {
  const lockDir = join(workspaceRoot, '.locks')
  const lockPath = join(lockDir, `${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.json`)
  mkdirSync(lockDir, { recursive: true })
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, actionId, purpose: 'review_promotion', startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let owner = null
    try { owner = JSON.parse(readFileSync(lockPath, 'utf8')) } catch {}
    if (owner?.pid && processIsAlive(Number(owner.pid))) throw new Error(`Repo is busy (pid ${owner.pid})`)
    rmSync(lockPath, { force: true })
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, actionId, purpose: 'review_promotion', startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  }
  let released = false
  return { release() { if (released) return; released = true; try { const owner = JSON.parse(readFileSync(lockPath, 'utf8')); if (Number(owner.pid) === process.pid) unlinkSync(lockPath) } catch {} } }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function assertClean(cwd) {
  const status = await run('git', ['status', '--porcelain'], cwd)
  if (status.stdout.trim()) throw new Error(`Repo is not clean: ${cwd}`)
}

async function runBestBuild(repoDir) {
  const cwd = existsSync(join(repoDir, 'package.json')) ? repoDir : existsSync(join(repoDir, 'web', 'package.json')) ? join(repoDir, 'web') : null
  if (!cwd) throw new Error('No package.json found for production build')
  const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  if (packageJson.scripts?.test) {
    await run('npm', ['test'], cwd, 15 * 60 * 1000)
  }
  if (packageJson.scripts?.['cf:build']) {
    await run('pnpm', ['run', 'cf:build'], cwd, 25 * 60 * 1000)
    return
  }
  await run('npm', ['run', 'build'], cwd, 20 * 60 * 1000)
}

async function runConfiguredProductionDeploy(repoDir) {
  const cwd = existsSync(join(repoDir, 'package.json')) ? repoDir : existsSync(join(repoDir, 'web', 'package.json')) ? join(repoDir, 'web') : null
  if (!cwd) return
  const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  const hasCloudflareConfig = existsSync(join(cwd, 'wrangler.jsonc')) || existsSync(join(cwd, 'wrangler.toml'))
  if (!packageJson.scripts?.deploy || !hasCloudflareConfig) return
  await run('pnpm', ['run', 'deploy'], cwd, 20 * 60 * 1000)
}

function hasConfiguredProductionDeploy(repoDir) {
  const cwd = existsSync(join(repoDir, 'package.json')) ? repoDir : existsSync(join(repoDir, 'web', 'package.json')) ? join(repoDir, 'web') : null
  if (!cwd) return false
  const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  const hasCloudflareConfig = existsSync(join(cwd, 'wrangler.jsonc')) || existsSync(join(cwd, 'wrangler.toml'))
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && packageJson.scripts?.deploy && hasCloudflareConfig)
}

async function restoreProductionFromMain(repoDir, baseBranch) {
  await run('git', ['checkout', '-B', baseBranch, `origin/${baseBranch}`], repoDir)
  await runBestBuild(repoDir)
  await runConfiguredProductionDeploy(repoDir)
}

async function reviewFingerprints(cwd, base, delivery) {
  const diff = (await run('git', ['diff', '--unified=0', `origin/${base}...origin/${delivery}`], cwd)).stdout
  return diff.split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .flatMap((line) => [...line.matchAll(/["'`](.{24,180}?)["'`]/g)].map((match) => match[1]))
    .map(normalizeText)
    .filter((text) => text.length >= 24 && !/^(https?:|class|import|seo-agent)/.test(text))
    .slice(0, 12)
}

async function verifyLiveTarget(url, fingerprints) {
  const deadline = Date.now() + Number(process.env.SEO_AGENT_PROD_VERIFY_MS || 5 * 60 * 1000)
  let lastStatus = null
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'SebCastwall-SEO-Agent/1.0', 'cache-control': 'no-cache' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      lastStatus = response.status
      const body = normalizeText(await response.text())
      const matchedFingerprint = fingerprints.find((fingerprint) => body.includes(fingerprint)) || null
      if (response.ok && (!fingerprints.length || matchedFingerprint)) return { ok: true, status: response.status, matchedFingerprint }
      lastError = response.ok ? 'new_content_not_visible_yet' : `http_${response.status}`
    } catch (error) {
      lastError = error?.message || String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 12_000))
  }
  return { ok: false, status: lastStatus, error: lastError, fingerprintCount: fingerprints.length }
}

async function verifyCriticalProductionExperience(repo) {
  if (repo !== 'sajden/parkeringspolaren-web') return { ok: true, note: 'no_repo_specific_check' }

  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (error) {
    return { ok: false, error: `Playwright kunde inte laddas: ${error?.code || error?.message || error}` }
  }

  const url = 'https://parkeringspolaren.se/sv/mc-parkering-jonkoping'
  const viewports = [
    { name: 'desktop', width: 1365, height: 768 },
    { name: 'mobil', width: 390, height: 844 }
  ]
  let browser
  try {
    browser = await chromium.launch({
      executablePath: process.env.SEO_AGENT_CHROME_PATH || '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    })
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport })
      try {
        const page = await context.newPage()
        const mapFailures = []
        page.on('requestfailed', (request) => {
          if (/(?:tile\.openstreetmap\.org|(?:api|events)\.mapbox\.com|tiles\.mapbox\.com)/i.test(request.url())) {
            mapFailures.push(request.failure()?.errorText || 'request_failed')
          }
        })
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
        if (!response?.ok()) throw new Error(`HTTP ${response?.status() || 'utan svar'}`)
        const map = page.locator('[data-map-engine]').first()
        await map.evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await map.waitFor({ state: 'visible', timeout: 15_000 })
        await page.waitForFunction(() => {
          const root = document.querySelector('[data-map-engine]')
          const count = Number(root?.getAttribute('data-map-record-count') || 0)
          return root?.getAttribute('data-map-layer-ready') === 'true' && count > 0
        }, undefined, { timeout: 15_000 })
        const engine = await map.getAttribute('data-map-engine')
        if (engine === 'mapbox') {
          await page.waitForFunction(() => {
            const canvas = document.querySelector('[data-map-engine] canvas.mapboxgl-canvas')
            return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0
          }, undefined, { timeout: 15_000 })
        } else if (engine === 'leaflet') {
          await page.waitForFunction(() => {
            return [...document.querySelectorAll('[data-map-engine] img.leaflet-tile')]
              .some((tile) => tile instanceof HTMLImageElement && tile.complete && tile.naturalWidth > 0)
          }, undefined, { timeout: 15_000 })
        } else {
          throw new Error(`okänd kartmotor: ${engine || 'saknas'}`)
        }
        if (mapFailures.length) throw new Error(`Map request failed: ${mapFailures[0]}`)
      } catch (error) {
        return { ok: false, error: `${viewport.name}: ${String(error?.message || error).split('\n')[0].slice(0, 500)}` }
      } finally {
        await context.close().catch(() => {})
      }
    }
    return { ok: true, url, viewports: viewports.map((viewport) => viewport.name) }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  } finally {
    await browser?.close().catch(() => {})
  }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\\[nrt]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|quot|#39);/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function run(command, args, cwd, timeout = 5 * 60 * 1000) {
  return exec(command, args, { cwd, env: runnerEnv, timeout, maxBuffer: 20 * 1024 * 1024 })
}
