#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

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
const promotionCapacity = await acquirePromotionCapacity(input.actionId || expectedCommit)
const lock = acquireRepoLock(repoName, input.actionId || expectedCommit)
process.on('exit', () => {
  lock.release()
  promotionCapacity.release()
})

let pushed = false
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
  await run('git', ['push', 'origin', `HEAD:${baseBranch}`], repoDir)
  pushed = true
  await runConfiguredProductionDeploy(repoDir)
  await run('git', ['fetch', 'origin', baseBranch], repoDir)
  await run('git', ['merge-base', '--is-ancestor', promotedCommit, `origin/${baseBranch}`], repoDir)

  const verification = targetUrl
    ? await verifyLiveTarget(targetUrl, fingerprints)
    : { ok: true, status: null, matchedFingerprint: null, note: 'no_target_url' }

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

async function acquirePromotionCapacity(actionId) {
  const lockDir = join(workspaceRoot, '.locks')
  const lockPath = join(lockDir, 'review-promotion-global.json')
  const deadline = Date.now() + 50 * 60 * 1000
  mkdirSync(lockDir, { recursive: true })
  while (Date.now() < deadline) {
    try {
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        actionId,
        purpose: 'review_promotion_global',
        startedAt: new Date().toISOString()
      }), { flag: 'wx', mode: 0o600 })
      let released = false
      return {
        release() {
          if (released) return
          released = true
          try {
            const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
            if (Number(owner.pid) === process.pid) unlinkSync(lockPath)
          } catch {}
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner = null
      try { owner = JSON.parse(readFileSync(lockPath, 'utf8')) } catch {}
      if (!owner?.pid || !processIsAlive(Number(owner.pid))) {
        rmSync(lockPath, { force: true })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
  throw new Error('Timed out waiting for another SEO review promotion to finish')
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
