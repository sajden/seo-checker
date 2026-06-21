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

await recoverInterruptedWorktree(repoDir, action)
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

async function recoverInterruptedWorktree(cwd, input) {
  const status = await run('git', ['status', '--porcelain'], cwd)
  if (!status.stdout.trim()) return
  const diffStat = await run('git', ['diff', '--stat'], cwd)
  await runBestBuild(bestBuildDir(cwd))
  await run('git', ['add', '-A'], cwd)
  const staged = await run('git', ['diff', '--cached', '--stat'], cwd)
  if (!staged.stdout.trim()) {
    await run('git', ['reset', '--hard'], cwd)
    return
  }
  await run('git', ['config', 'user.name', 'SEO Agent'], cwd)
  await run('git', ['config', 'user.email', 'seo-agent@sebcastwall.se'], cwd)
  await run('git', ['commit', '-m', `Recover interrupted SEO agent changes\n\nPrevious action context: ${input.id || input.title || 'unknown'}`], cwd)
  await run('git', ['push', 'origin', `HEAD:${input.branch || 'main'}`], cwd)
  recordCodexUsage({
    agent: 'seo-agent',
    purpose: 'worktree_recovery',
    workspace: input.workspaceSlug || input.projectSlug || input.repoFullName || null,
    status: 'ok',
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, calls: 0 },
    actionId: input.id,
    note: `Recovered dirty worktree before action. Diff: ${String(diffStat.stdout || staged.stdout || '').slice(0, 500)}`
  })
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
  const agentSpecs = readAgentSpecs(6000)
  const workspaceRules = workspaceImplementationRules(input)
  return [
    'You are implementing one approved SEO action. Keep the change minimal, scoped, and workspace-correct.',
    '',
    `SEO-action-id: ${input.id}`,
    `Workspace: ${input.workspaceSlug || input.projectSlug || ''}`,
    `Repo: ${input.repoFullName || ''}`,
    `Target URL: ${input.targetUrl || ''}`,
    `Keyword: ${input.keyword || ''}`,
    `Keyword Planner metrics: ${formatKeywordMetrics(input.keywordMetrics)}`,
    `Title: ${input.title || ''}`,
    `Why: ${input.why || ''}`,
    `Recommended action: ${input.recommendedAction || ''}`,
    '',
    'Workspace implementation rules:',
    workspaceRules,
    '',
    'Agent memory/spec excerpt:',
    agentSpecs,
    '',
    'Rules:',
    '- Work directly on the current main checkout.',
    '- Do not touch unrelated files.',
    '- Do not change deploy config, auth, API integrations, pricing, redirects, or routing unless the action explicitly requires it.',
    '- Prefer metadata, copy, schema, internal links, FAQ, or small existing-page changes.',
    '- If the action text contains a generic template that conflicts with the workspace rules, rewrite the implementation around the workspace rules instead of copying the template.',
    '- Do not add B2B/SMB/konsult/SaaS language to consumer utilities such as vagkollen.se or parkeringspolaren.se.',
    '- Do not repeat a previously completed page/keyword experiment unless the action provides new evidence or a clearly different hypothesis.',
    '- If the keyword is broad, one-word, or weakly evidenced, make only a conservative improvement tied to the actual user intent of the site.',
    '- Leave the repo buildable.',
  ].join('\n')
}

function readAgentSpecs(maxChars = 6000) {
  const base = '/home/deploy/seo-agent-discord'
  const localBase = new URL('.', import.meta.url).pathname
  const parts = []
  for (const file of ['AGENTS.md', 'MEMORY.md']) {
    for (const dir of [base, localBase]) {
      const path = join(dir, file)
      if (!existsSync(path)) continue
      parts.push(readFileSync(path, 'utf8'))
      break
    }
  }
  return parts.join('\n\n').slice(0, maxChars) || 'No agent specs available.'
}

function workspaceImplementationRules(input) {
  const haystack = [
    input.workspaceSlug,
    input.projectSlug,
    input.repoFullName,
    input.targetUrl,
    input.gscProperty,
    input.title,
    input.why,
    input.recommendedAction,
  ].filter(Boolean).join(' ').toLowerCase()

  if (/vagkollen|vägkollen/.test(haystack)) {
    return [
      'vagkollen.se is a consumer road-weather and route-planning utility.',
      'Use driver scenarios, route checks, weather along the road, traffic, road conditions, safety, timing, road trips and practical travel use cases.',
      'Never frame it as SMB, B2B, consulting, SaaS, customer visits, service firms, internal tools, invoices or integrations.',
    ].join(' ')
  }
  if (/parkeringspolaren/.test(haystack)) {
    return [
      'parkeringspolaren.se is a consumer/local parking service.',
      'Use parking search, airport parking, long-term parking, location, price/time factors, booking flow and conversion use cases.',
      'Never frame it as SMB, B2B, consulting, SaaS, internal tools, invoices or integrations.',
    ].join(' ')
  }
  if (/natverkskollen|nätverkskollen/.test(haystack)) {
    return [
      'natverkskollen.se is an event/networking discovery service.',
      'Use startup events, entrepreneurs, networking, city/event category pages and evergreen event landing pages.',
      'Avoid agency, integration and software-consultancy angles unless explicitly requested.',
    ].join(' ')
  }
  if (/sebcastwall/.test(haystack)) {
    return [
      'sebcastwall.se is an AI/coding/automation consultancy.',
      'Prioritize AI agents, AI automation, app/web development, internal tools, AI education, workshops and practical implementation credibility.',
      'Deprioritize pure bookkeeping, invoice, Fortnox, Visma and generic integration angles unless tied to AI/coding strategy.',
    ].join(' ')
  }
  return 'Infer the workspace from repo, URL and page content. Do not use generic SEO filler if it does not match the actual product/site.'
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
