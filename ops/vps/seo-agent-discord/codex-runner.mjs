#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const runnerEnv = { ...process.env, PATH: `/home/deploy/.npm-global/bin:/home/deploy/.local/bin:${process.env.PATH || ""}` }
const workspaceRoot = '/home/deploy/seo-agent-workspaces'
const action = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const repoName = String(action.repoFullName || '').split('/')[1]
if (!repoName) throw new Error('Missing repoFullName in action payload')
const repoDir = join(workspaceRoot, repoName)
await ensureRepoCheckout(repoDir, action.repoFullName)

await assertClean(repoDir)
await run('git', ['checkout', action.branch || 'main'], repoDir)
await run("git", ["fetch", "origin", action.branch || "main"], repoDir)
await run("git", ["merge", "--ff-only", "FETCH_HEAD"], repoDir)

const prompt = buildPrompt(action)
const promptPath = join('/home/deploy/seo-agent-discord/state/codex-prompts', `${action.id}.md`)
mkdirSync(dirname(promptPath), { recursive: true })
writeFileSync(promptPath, prompt)

const codexRun = await run("bash", ["-lc", `codex exec --json --cd ${repoDir} --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`], repoDir)
const codexUsage = extractCodexUsage(codexRun.stdout || '')
recordCodexUsage({
  agent: 'seo-agent',
  purpose: 'code_action',
  workspace: action.workspaceSlug || action.projectSlug || action.repoFullName || null,
  status: 'ok',
  usage: codexUsage,
  actionId: action.id
})

await runBestBuild(bestBuildDir(repoDir))
await run('git', ['add', '-A'], repoDir)
const diff = await run('git', ['diff', '--cached', '--stat'], repoDir)
if (!diff.stdout.trim()) throw new Error('Codex made no changes')
await run('git', ['config', 'user.name', 'SEO Agent'], repoDir)
await run('git', ['config', 'user.email', 'seo-agent@sebcastwall.se'], repoDir)
await run('git', ['commit', '-m', `${action.title || 'SEO action'}\n\nSEO-action-id: ${action.id}`], repoDir)
const commit = await run('git', ['rev-parse', '--short', 'HEAD'], repoDir)
await run('git', ['push', 'origin', `HEAD:${action.branch || 'main'}`], repoDir)

console.log(JSON.stringify({ ok: true, repoDir, actionId: action.id, commit: commit.stdout.trim(), diffStat: diff.stdout, codexUsage }, null, 2))

async function ensureRepoCheckout(repoDir, repoFullName) {
  if (existsSync(join(repoDir, '.git'))) return
  if (existsSync(repoDir)) throw new Error(`Repo checkout path exists but is not a git checkout: ${repoDir}`)
  mkdirSync(workspaceRoot, { recursive: true })
  const repo = String(repoFullName || '').trim()
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new Error(`Invalid repoFullName for checkout: ${repo}`)
  const urls = [
    `github.com-seo-agent-${name}:${owner}/${name}.git`,
    `git@github.com:${owner}/${name}.git`
  ]
  const errors = []
  for (const url of urls) {
    try {
      await run('git', ['clone', url, repoDir], workspaceRoot)
      return
    } catch (error) {
      errors.push(`${url}: ${error?.stderr || error?.message || String(error)}`.slice(0, 700))
    }
  }
  throw new Error(`Repo checkout missing and clone failed: ${repoDir}\n${errors.join('\n')}`)
}

function bestBuildDir(repoDir) {
  if (existsSync(join(repoDir, "package.json"))) return repoDir
  if (existsSync(join(repoDir, "web", "package.json"))) return join(repoDir, "web")
  return repoDir
}

async function assertClean(cwd) {
  const status = await run('git', ['status', '--porcelain'], cwd)
  if (status.stdout.trim()) throw new Error(`Repo is not clean: ${cwd}`)
}

async function runBestBuild(cwd) {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const scripts = pkg.scripts || {}
  if (scripts.typecheck) await runPackageScript(cwd, 'typecheck')
  if (scripts.build) await runPackageScript(cwd, 'build')
}

async function runPackageScript(cwd, script) {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return run('pnpm', ['run', script], cwd)
  if (existsSync(join(cwd, 'yarn.lock'))) return run('yarn', [script], cwd)
  return run('npm', ['run', script], cwd)
}

async function run(cmd, args, cwd) {
  return exec(cmd, args, { cwd, env: runnerEnv, timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 })
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

function recordCodexUsage(entry) {
  const usagePath = '/home/deploy/seo-agent-discord/state/codex-usage.jsonl'
  const payload = { at: new Date().toISOString(), ...entry }
  appendFileSync(usagePath, `${JSON.stringify(payload)}\n`)
  mkdirSync('/home/deploy/agent-usage', { recursive: true })
  appendFileSync('/home/deploy/agent-usage/codex-usage.jsonl', `${JSON.stringify(payload)}\n`)
}

function buildPrompt(input) {
  return [
    'You are implementing one approved SEO action. Keep the change minimal and scoped.',
    '',
    `SEO-action-id: ${input.id}`,
    `Workspace: ${input.workspaceSlug || input.projectSlug || ''}`,
    `Target URL: ${input.targetUrl || ''}`,
    `Keyword: ${input.keyword || ''}`,
    `Keyword Planner metrics: ${formatKeywordMetrics(input.keywordMetrics)}`,
    `Title: ${input.title || ''}`,
    `Why: ${input.why || ''}`,
    `Recommended action: ${input.recommendedAction || ''}`,
    '',
    'Rules:',
    '- Work directly on the current main checkout.',
    '- Do not touch unrelated files.',
    '- Do not change deploy config, auth, API integrations, pricing, redirects, or routing unless the action explicitly requires it.',
    '- Prefer metadata, copy, schema, internal links, FAQ, or small existing-page changes.',
    '- Leave the repo buildable.',
  ].join('\n')
}

function formatKeywordMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return 'not available'
  return [
    metrics.avgMonthlySearches !== undefined && metrics.avgMonthlySearches !== null ? `avgMonthlySearches=${metrics.avgMonthlySearches}` : '',
    metrics.competition ? `competition=${metrics.competition}` : '',
    metrics.lowTopOfPageBid !== undefined && metrics.lowTopOfPageBid !== null ? `lowTopOfPageBidSek=${metrics.lowTopOfPageBid}` : '',
    metrics.highTopOfPageBid !== undefined && metrics.highTopOfPageBid !== null ? `highTopOfPageBidSek=${metrics.highTopOfPageBid}` : '',
    metrics.averageCpc !== undefined && metrics.averageCpc !== null ? `averageCpcSek=${metrics.averageCpc}` : ''
  ].filter(Boolean).join(', ') || 'not available'
}
