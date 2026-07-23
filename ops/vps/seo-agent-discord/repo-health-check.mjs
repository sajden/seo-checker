#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const workspaceRoot = process.env.SEO_AGENT_WORKSPACE_ROOT || '/home/deploy/seo-agent-workspaces'
const logPath = process.env.SEO_AGENT_REPO_HEALTH_LOG || '/mnt/HC_Volume_105954589/deploy-storage/logs/seo-agent-repo-health.jsonl'
const repos = (process.env.SEO_AGENT_REPOS || 'sebcastwall,natverkskollen,parkeringspolaren-web,vagkollen')
  .split(',')
  .map((repo) => repo.trim())
  .filter(Boolean)
const branch = process.env.SEO_AGENT_REPO_BRANCH || 'main'
const runnerEnv = { ...process.env, PATH: `/home/deploy/.npm-global/bin:/home/deploy/.local/bin:${process.env.PATH || ''}` }

mkdirSync(dirname(logPath), { recursive: true })

const results = []
for (const repo of repos) {
  results.push(await checkRepo(repo).catch((error) => ({
    repo,
    ok: false,
    status: 'failed',
    error: String(error?.stderr || error?.message || error).slice(0, 800)
  })))
}

const payload = { at: new Date().toISOString(), results }
appendFileSync(logPath, `${JSON.stringify(payload)}\n`)
console.log(JSON.stringify(payload, null, 2))

const failed = results.filter((item) => !item.ok)
if (failed.length) process.exitCode = 1

async function checkRepo(repo) {
  const dir = join(workspaceRoot, repo)
  if (!existsSync(join(dir, '.git'))) return { repo, ok: false, status: 'missing_checkout', dir }
  const activePromotion = activePromotionLock(repo)
  if (activePromotion) {
    return {
      repo,
      ok: true,
      status: 'busy_review_promotion',
      dir,
      actionId: activePromotion.actionId || null,
      pid: activePromotion.pid
    }
  }
  const status = await run('git', ['status', '--porcelain'], dir)
  if (status.stdout.trim()) return { repo, ok: false, status: 'dirty_worktree', dir, details: status.stdout.slice(0, 800) }
  await run('git', ['fetch', 'origin', branch], dir)
  await run('git', ['merge', '--ff-only', 'FETCH_HEAD'], dir)
  await run('git', ['push', '--dry-run', 'origin', `HEAD:${branch}`], dir)
  const head = await run('git', ['rev-parse', '--short', 'HEAD'], dir)
  return { repo, ok: true, status: 'ready', dir, head: head.stdout.trim() }
}

function activePromotionLock(repo) {
  const lockPath = join(workspaceRoot, '.locks', `${repo.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.json`)
  if (!existsSync(lockPath)) return null
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    const pid = Number(lock?.pid)
    if (lock?.purpose !== 'review_promotion' || !Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return { ...lock, pid }
  } catch {
    return null
  }
}

function run(cmd, args, cwd) {
  return exec(cmd, args, { cwd, env: runnerEnv, timeout: 2 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 })
}
