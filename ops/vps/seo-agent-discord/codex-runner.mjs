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

const quality = await runQualityGate(repoDir, action)
await runBestBuild(bestBuildDir(repoDir))
await run('git', ['add', '-A'], repoDir)
const diff = await run('git', ['diff', '--cached', '--stat'], repoDir)
if (!diff.stdout.trim()) throw new Error('Codex made no changes')
await run('git', ['config', 'user.name', 'SEO Agent'], repoDir)
await run('git', ['config', 'user.email', 'seo-agent@sebcastwall.se'], repoDir)
await run('git', ['commit', '-m', `${action.title || 'SEO action'}\n\nSEO-action-id: ${action.id}`], repoDir)
const commit = await run('git', ['rev-parse', '--short', 'HEAD'], repoDir)
await run('git', ['push', 'origin', `HEAD:${action.branch || 'main'}`], repoDir)

console.log(JSON.stringify({ ok: true, repoDir, actionId: action.id, commit: commit.stdout.trim(), diffStat: diff.stdout, codexUsage, quality }, null, 2))

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

async function runQualityGate(repoDir, input) {
  let lastReview = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const diffStat = await run('git', ['diff', '--stat'], repoDir)
    if (!diffStat.stdout.trim()) throw new Error('Codex made no changes')
    const diff = await run('git', ['diff', '--', '.'], repoDir)
    const review = await reviewDiffWithCodex(repoDir, input, diffStat.stdout, diff.stdout, attempt)
    lastReview = review
    if (review.decision === 'allow') return { ok: true, attempts: attempt, review }
    if (review.decision === 'block') {
      await rejectDirtyWorktree(repoDir, input, review)
      throw new Error(`SEO quality gate blocked commit: ${review.reason || 'quality_blocked'}`)
    }
    if (review.decision === 'revise' && attempt < 2) {
      await reviseDiffWithCodex(repoDir, input, review, attempt)
      continue
    }
    await rejectDirtyWorktree(repoDir, input, review)
    throw new Error(`SEO quality gate did not approve after revision: ${review.reason || 'quality_not_approved'}`)
  }
  await rejectDirtyWorktree(repoDir, input, lastReview || { reason: 'quality_unknown' })
  throw new Error('SEO quality gate failed without approval')
}

async function reviewDiffWithCodex(repoDir, input, diffStat, diff, attempt) {
  const promptPath = join('/home/deploy/seo-agent-discord/state/codex-prompts', `${input.id}.quality.${attempt}.md`)
  mkdirSync(dirname(promptPath), { recursive: true })
  const prompt = [
    'Du är SEO Agentens pre-commit quality reviewer.',
    'Bedöm om diffen ska få committas. Returnera ENDAST JSON:',
    '{"decision":"allow|revise|block","reason":"kort orsak","requiredFix":"om revise, exakt vad kodaren ska ändra","confidence":0.0}',
    '',
    'Allow bara om diffen:',
    '- matchar rätt workspace och målgrupp,',
    '- är en konkret SEO-förbättring med rimlig hypotes,',
    '- är tydligt kopplad till target URL/keyword eller workspace-mål,',
    '- inte lägger in generisk malltext,',
    '- inte upprepar samma experiment utan ny evidens,',
    '- inte lägger SMB/B2B/konsult/SaaS-språk på konsumenttjänster.',
    '',
    'Revise om diffen kan räddas med en liten ändring.',
    'Block om den är fel workspace, för generisk, farlig, irrelevant eller saknar trovärdig SEO-hypotes.',
    '',
    'Workspace rules:',
    workspaceImplementationRules(input),
    '',
    'Agent memory/spec excerpt:',
    readAgentSpecs(6000),
    '',
    'Action JSON:',
    JSON.stringify({
      id: input.id,
      workspaceSlug: input.workspaceSlug,
      projectSlug: input.projectSlug,
      repoFullName: input.repoFullName,
      targetUrl: input.targetUrl,
      keyword: input.keyword,
      keywordMetrics: input.keywordMetrics,
      keywordMetricsStatus: input.keywordMetricsStatus,
      title: input.title,
      why: input.why,
      recommendedAction: input.recommendedAction,
      evidenceSource: input.evidenceSource,
      evidenceRunAt: input.evidenceRunAt
    }, null, 2),
    '',
    'Diff stat:',
    String(diffStat || '').slice(0, 4000),
    '',
    'Diff:',
    String(diff || '').slice(0, 28000)
  ].join('\n')
  writeFileSync(promptPath, prompt)
  const result = await run("bash", ["-lc", `codex exec --json --cd /home/deploy/seo-agent-discord --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`], '/home/deploy/seo-agent-discord')
  const usage = extractCodexUsage(result.stdout || '')
  recordCodexUsage({
    agent: 'seo-agent',
    purpose: 'code_quality_review',
    workspace: input.workspaceSlug || input.projectSlug || input.repoFullName || null,
    status: 'ok',
    usage,
    actionId: input.id
  })
  return normalizeQualityReview(extractCodexExecText(result.stdout || ''))
}

async function reviseDiffWithCodex(repoDir, input, review, attempt) {
  const promptPath = join('/home/deploy/seo-agent-discord/state/codex-prompts', `${input.id}.revision.${attempt}.md`)
  mkdirSync(dirname(promptPath), { recursive: true })
  const prompt = [
    'You are fixing an SEO code change that failed pre-commit review.',
    'Make the smallest correction needed. Keep the repo buildable. Do not add unrelated changes.',
    '',
    `SEO-action-id: ${input.id}`,
    `Workspace: ${input.workspaceSlug || input.projectSlug || ''}`,
    `Repo: ${input.repoFullName || ''}`,
    `Target URL: ${input.targetUrl || ''}`,
    `Keyword: ${input.keyword || ''}`,
    `Title: ${input.title || ''}`,
    '',
    'Workspace implementation rules:',
    workspaceImplementationRules(input),
    '',
    'Quality review that must be fixed:',
    JSON.stringify(review, null, 2),
    '',
    'Fix requirements:',
    review.requiredFix || review.reason || 'Make the diff workspace-correct and less generic.'
  ].join('\n')
  writeFileSync(promptPath, prompt)
  const result = await run("bash", ["-lc", `codex exec --json --cd ${repoDir} --dangerously-bypass-approvals-and-sandbox - < ${promptPath}`], repoDir)
  const usage = extractCodexUsage(result.stdout || '')
  recordCodexUsage({
    agent: 'seo-agent',
    purpose: 'code_quality_revision',
    workspace: input.workspaceSlug || input.projectSlug || input.repoFullName || null,
    status: 'ok',
    usage,
    actionId: input.id
  })
}

async function rejectDirtyWorktree(repoDir, input, review) {
  const diff = await run('git', ['diff'], repoDir).catch(() => ({ stdout: '' }))
  const rejectDir = '/home/deploy/seo-agent-discord/state/rejected-diffs'
  mkdirSync(rejectDir, { recursive: true })
  const safeId = String(input.id || input.title || Date.now()).replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 160)
  const patchPath = join(rejectDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeId}.patch`)
  writeFileSync(patchPath, [
    `# Rejected SEO action: ${input.id || ''}`,
    `# Reason: ${review?.reason || 'quality_blocked'}`,
    `# Required fix: ${review?.requiredFix || ''}`,
    '',
    diff.stdout || ''
  ].join('\n'))
  await run('git', ['reset', '--hard'], repoDir)
  recordCodexUsage({
    agent: 'seo-agent',
    purpose: 'code_quality_rejected',
    workspace: input.workspaceSlug || input.projectSlug || input.repoFullName || null,
    status: 'blocked',
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, calls: 0 },
    actionId: input.id,
    note: `Rejected dirty worktree saved to ${patchPath}. Reason: ${review?.reason || 'quality_blocked'}`
  })
}

function extractCodexExecText(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
  const texts = []
  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      if (typeof event.output_text === 'string') texts.push(event.output_text)
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') texts.push(event.item.text)
      if (typeof event.text === 'string' && /message|response|final|agent/i.test(String(event.type || ''))) texts.push(event.text)
      if (typeof event.message === 'string' && event.type && /message|response|final/i.test(String(event.type))) texts.push(event.message)
      if (Array.isArray(event.output)) {
        for (const item of event.output) {
          for (const content of item.content || []) if (typeof content.text === 'string') texts.push(content.text)
        }
      }
    } catch {}
  }
  if (texts.length) return texts[texts.length - 1].trim()
  return ''
}

function normalizeQualityReview(text) {
  const raw = String(text || '').trim()
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw
  let parsed = null
  try { parsed = JSON.parse(jsonText) } catch {
    return { decision: 'revise', reason: 'quality_review_json_parse_failed', requiredFix: 'Re-check the diff and make it clearly workspace-correct.', confidence: 0 }
  }
  const decision = ['allow', 'revise', 'block'].includes(parsed.decision) ? parsed.decision : 'revise'
  return {
    decision,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : '',
    requiredFix: typeof parsed.requiredFix === 'string' ? parsed.requiredFix.slice(0, 1000) : '',
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0
  }
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
