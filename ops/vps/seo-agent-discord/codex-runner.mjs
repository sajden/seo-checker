#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const runnerEnv = { ...process.env, PATH: `/home/deploy/.npm-global/bin:/home/deploy/.local/bin:${process.env.PATH || ""}` }
const codexCli = process.env.CODEX_CLI || '/home/deploy/.npm-global/bin/codex'
const workspaceRoot = '/home/deploy/seo-agent-workspaces'
const skipGithubActions = process.env.SEO_AGENT_SKIP_GITHUB_ACTIONS !== 'false'
const deploySebcastwallDev = process.env.SEO_AGENT_DEPLOY_SEBCASTWALL_DEV !== 'false'
const action = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const repoName = String(action.repoFullName || '').split('/')[1]
if (!repoName) throw new Error('Missing repoFullName in action payload')
const repoLock = acquireRepoLock(repoName, action)
process.on('exit', repoLock.release)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    repoLock.release()
    process.kill(process.pid, signal)
  })
}
const baseBranch = action.branch || 'main'
const requiresReview = isSebcastwallAction(action, repoName)
const deliveryBranch = requiresReview
  ? `seo-agent/${safeBranchPart(action.id || action.title || Date.now())}`
  : baseBranch
const repoDir = join(workspaceRoot, repoName)
assertActionHasSeoEvidence(action)
await ensureRepoCheckout(repoDir, action.repoFullName)

await recoverInterruptedWorktree(repoDir, action)
await assertClean(repoDir)
await run('git', ['checkout', baseBranch], repoDir)
await run("git", ["fetch", "origin", baseBranch], repoDir)
await run("git", ["merge", "--ff-only", "FETCH_HEAD"], repoDir)
if (requiresReview) await run('git', ['checkout', '-B', deliveryBranch], repoDir)

const prompt = buildPrompt(action)
const promptPath = join('/home/deploy/seo-agent-discord/state/codex-prompts', `${action.id}.md`)
mkdirSync(dirname(promptPath), { recursive: true })
writeFileSync(promptPath, prompt)

const codexRun = await runCodexPrompt(repoDir, promptPath, repoDir)
const codexUsage = extractCodexUsage(codexRun.stdout || '')
recordCodexUsage({
  agent: 'seo-agent',
  purpose: 'code_action',
  workspace: action.workspaceSlug || action.projectSlug || action.repoFullName || null,
  status: 'ok',
  usage: codexUsage,
  actionId: action.id
})

await exposeCodexCommitAsReviewableDiff(repoDir)

await runWorkspaceSafetyGate(repoDir, action)
const quality = await runQualityGate(repoDir, action)
const safety = await runWorkspaceSafetyGate(repoDir, action)
await runBestBuild(bestBuildDir(repoDir))
await run('git', ['add', '-A'], repoDir)
const diff = await run('git', ['diff', '--cached', '--stat'], repoDir)
if (!diff.stdout.trim()) throw new Error('Codex made no changes')
await run('git', ['config', 'user.name', 'SEO Agent'], repoDir)
await run('git', ['config', 'user.email', 'seo-agent@sebcastwall.se'], repoDir)
await run('git', ['commit', '-m', seoAgentCommitMessage(action.title || 'SEO action', `SEO-action-id: ${action.id}`)], repoDir)
const commit = await run('git', ['rev-parse', '--short', 'HEAD'], repoDir)
await run('git', ['push', '--force-with-lease', 'origin', `HEAD:${deliveryBranch}`], repoDir)

const devDeployment = requiresReview
  ? await deployReviewBranchToDev(bestBuildDir(repoDir))
  : { attempted: false, ok: false, url: null, error: null }

const reviewUrl = requiresReview
  ? `https://github.com/${action.repoFullName}/compare/${baseBranch}...${deliveryBranch}?expand=1`
  : null
console.log(JSON.stringify({
  ok: true,
  repoDir,
  actionId: action.id,
  commit: commit.stdout.trim(),
  diffStat: diff.stdout,
  codexUsage,
  quality: { ...quality, safety },
  reviewContext: {
    targetUrl: action.targetUrl || action.url || '',
    keyword: action.keyword || '',
    why: action.why || '',
    intendedChange: action.recommendedAction || action.title || ''
  },
  baseBranch,
  deliveryBranch,
  requiresReview,
  reviewUrl,
  devDeployment,
  devUrl: devDeployment.ok ? devDeployment.url : null,
  mergedToMain: !requiresReview
}, null, 2))

function acquireRepoLock(name, input) {
  const lockDir = join(workspaceRoot, '.locks')
  const lockPath = join(lockDir, `${safeBranchPart(name)}.json`)
  mkdirSync(lockDir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, actionId: input.id || null, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
      let released = false
      return {
        path: lockPath,
        release() {
          if (released) return
          released = true
          try {
            const current = JSON.parse(readFileSync(lockPath, 'utf8'))
            if (Number(current.pid) === process.pid) unlinkSync(lockPath)
          } catch {}
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner = null
      try { owner = JSON.parse(readFileSync(lockPath, 'utf8')) } catch {}
      const ownerPid = Number(owner?.pid || 0)
      if (ownerPid && processIsAlive(ownerPid)) {
        throw new Error(`SEO repo already has an active runner: ${name} (pid ${ownerPid}, action ${owner?.actionId || 'unknown'})`)
      }
      rmSync(lockPath, { force: true })
    }
  }
  throw new Error(`Could not acquire SEO repo lock: ${name}`)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function assertActionHasSeoEvidence(input) {
  if (!isSebcastwallAction(input, repoName)) return
  const keyword = String(input?.keyword || '').trim()
  const instruction = [input?.title, input?.recommendedAction].filter(Boolean).join(' ').toLowerCase()
  if (!keyword || !/t[aä]ck keyword|serp-gap|l[aä]gg in keyword|title\/h1\/h2\/meta/.test(instruction)) return

  const volume = Number(input?.keywordMetrics?.avgMonthlySearches)
  const hasPlannerDemand = Number.isFinite(volume) && volume > 0
  const evidence = [input?.why, ...(Array.isArray(input?.evidence) ? input.evidence : [])].filter(Boolean).join(' ').toLowerCase()
  const hasPositiveGscEvidence = /gsc|search console/.test(evidence)
    && /(?:\b[1-9]\d*\b)\s*(?:klick|click|impression)|query\s+matchade|sökfråga\s+matchade/.test(evidence)
    && !/ingen gsc-query matchade|ingen sökfråga matchade|0\s*(?:klick|click|impression)/.test(evidence)
  if (!hasPlannerDemand && !hasPositiveGscEvidence) {
    throw new Error(`SEO evidence gate blocked exact-keyword coverage without verified demand: ${keyword}`)
  }
}

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
  await run('git', ['commit', '-m', seoAgentCommitMessage('Recover interrupted SEO agent changes', `Previous action context: ${input.id || input.title || 'unknown'}`)], cwd)
  await run('git', ['push', '--force-with-lease', 'origin', `HEAD:${deliveryBranch}`], cwd)
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

async function finalizeExistingSeoAgentCommit(cwd, input, codexUsage = null) {
  const status = await run('git', ['status', '--porcelain'], cwd)
  if (status.stdout.trim()) return null
  const ahead = await run('git', ['rev-list', '--count', `origin/${baseBranch}..HEAD`], cwd).catch(() => ({ stdout: '0' }))
  if (Number(ahead.stdout.trim() || '0') <= 0) return null
  const meta = await run('git', ['show', '-s', '--format=%an%x00%ae%x00%s%x00%b', 'HEAD'], cwd)
  const [authorName, authorEmail, subject, body] = meta.stdout.split('\u0000')
  const bySeoAgent = /SEO Agent/i.test(authorName || '') || /seo-agent/i.test(authorEmail || '')
  const related = String(subject || '').toLowerCase().includes(String(input.title || '').toLowerCase().slice(0, 32))
    || String(body || '').includes(input.id || '')
    || bySeoAgent
  if (!bySeoAgent || !related) return null
  await ensureSeoAgentCommitSkipsGithubActions(cwd)
  await runBestBuild(bestBuildDir(cwd))
  const diff = await run('git', ['diff', '--stat', `origin/${baseBranch}..HEAD`], cwd)
  await run('git', ['push', '--force-with-lease', 'origin', `HEAD:${deliveryBranch}`], cwd)
  const commit = await run('git', ['rev-parse', '--short', 'HEAD'], cwd)
  return {
    ok: true,
    repoDir: cwd,
    actionId: input.id,
    commit: commit.stdout.trim(),
    diffStat: diff.stdout,
    codexUsage,
    quality: {
      ok: true,
      recoveredCommittedByCodex: true,
      review: {
        decision: 'allow',
        reason: 'Codex created a clean SEO Agent commit before runner commit phase; build passed and runner pushed it.'
      }
    }
  }
}

async function exposeCodexCommitAsReviewableDiff(cwd) {
  const ahead = await run('git', ['rev-list', '--count', `origin/${baseBranch}..HEAD`], cwd).catch(() => ({ stdout: '0' }))
  if (Number(ahead.stdout.trim() || '0') <= 0) return
  await run('git', ['reset', '--mixed', `origin/${baseBranch}`], cwd)
}

async function runBestBuild(cwd) {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const scripts = pkg.scripts || {}
  if (scripts.typecheck) await runPackageScript(cwd, 'typecheck')
  if (scripts.build) await runBuildScriptWithRecovery(cwd)
}

async function deployReviewBranchToDev(cwd) {
  const url = 'https://dev.sebcastwall.se'
  if (!deploySebcastwallDev) return { attempted: false, ok: false, url, error: 'disabled' }
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return { attempted: false, ok: false, url, error: 'package_json_missing' }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (!pkg.scripts?.['deploy:dev']) return { attempted: false, ok: false, url, error: 'deploy_dev_script_missing' }
  try {
    await runPackageScript(cwd, 'deploy:dev')
    return { attempted: true, ok: true, url, error: null }
  } catch (error) {
    return { attempted: true, ok: false, url, error: String(error?.stderr || error?.message || error).slice(0, 1200) }
  }
}

async function runPackageScript(cwd, script) {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return run('pnpm', ['run', script], cwd)
  if (existsSync(join(cwd, 'yarn.lock'))) return run('yarn', [script], cwd)
  return run('npm', ['run', script], cwd)
}

async function runBuildScriptWithRecovery(cwd) {
  try {
    return await runPackageScript(cwd, 'build')
  } catch (error) {
    if (!isRecoverableNextBuildCacheError(error)) throw error
    rmSync(join(cwd, '.next'), { recursive: true, force: true })
    return runPackageScript(cwd, 'build')
  }
}

function isRecoverableNextBuildCacheError(error) {
  const text = `${error?.message || ''}\n${error?.stdout || ''}\n${error?.stderr || ''}`.toLowerCase()
  return text.includes('.next/')
    && text.includes('enoent')
    && (text.includes('build-manifest.json') || text.includes('pages-manifest.json') || text.includes('app-build-manifest.json'))
}

function seoAgentCommitMessage(subject, body = '') {
  const cleanSubject = String(subject || 'SEO action').trim()
  const suffix = skipGithubActions && !/\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i.test(cleanSubject)
    ? ' [skip ci]'
    : ''
  return `${cleanSubject}${suffix}${body ? `\n\n${body}` : ''}`
}

async function ensureSeoAgentCommitSkipsGithubActions(cwd) {
  if (!skipGithubActions) return
  const meta = await run('git', ['show', '-s', '--format=%s%x00%b', 'HEAD'], cwd)
  const [subject, body = ''] = meta.stdout.split('\u0000')
  if (/\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i.test(subject || '')) return
  await run('git', ['commit', '--amend', '-m', seoAgentCommitMessage(subject || 'SEO action', String(body || '').trim())], cwd)
}

async function run(cmd, args, cwd) {
  return exec(cmd, args, { cwd, env: runnerEnv, timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 })
}

async function runCodexPrompt(cdDir, promptPath, cwd) {
  return run('bash', ['-c', `${shellQuote(codexCli)} exec --json --cd ${shellQuote(cdDir)} --dangerously-bypass-approvals-and-sandbox - < ${shellQuote(promptPath)}`], cwd)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
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
    ...(isSebcastwallAction(input, repoName) ? [
      '- för Sebcastwall lämnar godkänd design, CSS, bilder, navigation, komponentstruktur, formulär, CTA-beteende, priser och routes helt orörda,',
      '- för Sebcastwall använder aktuella canonical routes och skapar inte nya servicesidor utan operatörsbeslut.',
      '- blockerar exact-match keyword stuffing i title, H1 och meta när positiv GSC-evidens eller verifierad Keyword Planner-volym saknas; frånvaro av keyword är inte i sig en SEO-hypotes.'
    ] : []),
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
  const result = await runCodexPrompt('/home/deploy/seo-agent-discord', promptPath, '/home/deploy/seo-agent-discord')
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
  const result = await runCodexPrompt(repoDir, promptPath, repoDir)
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

async function runWorkspaceSafetyGate(repoDir, input) {
  if (!isSebcastwallAction(input, repoName)) return { ok: true, profile: 'default' }

  const nameStatus = await run('git', ['diff', '--name-status', '--', '.'], repoDir)
  const changed = String(nameStatus.stdout || '').trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [status, ...parts] = line.split('\t')
    return { status, path: parts[parts.length - 1] || '' }
  })
  const blockedPaths = changed.filter(({ path }) => (
    /(^|\/)app\/_components\//.test(path)
    || /(^|\/)app\/tjanster\/_components\//.test(path)
    || /(^|\/)app\/(kontakt|api)\//.test(path)
    || /(^|\/)public\//.test(path)
    || /\.css$/.test(path)
    || /(^|\/)(package\.json|next\.config\.[^/]+|wrangler\.jsonc|middleware\.[^/]+)$/.test(path)
  ))
  if (blockedPaths.length) {
    await rejectDirtyWorktree(repoDir, input, { reason: `sebcastwall_design_freeze:${blockedPaths.map((item) => item.path).join(',')}` })
    throw new Error(`Sebcastwall SEO safety gate blocked design/system files: ${blockedPaths.map((item) => item.path).join(', ')}`)
  }

  const unsafeLifecycle = changed.filter(({ status, path }) => /^[DR]/.test(status) || (status === 'A' && !/^content\/articles\/[^/]+\.mdx$/.test(path)))
  if (unsafeLifecycle.length) {
    await rejectDirtyWorktree(repoDir, input, { reason: `sebcastwall_route_or_file_lifecycle:${unsafeLifecycle.map((item) => `${item.status}:${item.path}`).join(',')}` })
    throw new Error('Sebcastwall SEO safety gate blocks deletes, renames and new non-article files')
  }

  const meaningfulFiles = changed.filter(({ path }) => !/^lib\/content\/generated-/.test(path))
  if (meaningfulFiles.length > 3) {
    await rejectDirtyWorktree(repoDir, input, { reason: `sebcastwall_change_too_broad:${meaningfulFiles.length}_files` })
    throw new Error(`Sebcastwall SEO safety gate allows at most 3 source files, got ${meaningfulFiles.length}`)
  }

  const numstat = await run('git', ['diff', '--numstat', '--', '.'], repoDir)
  const changedLines = String(numstat.stdout || '').trim().split(/\r?\n/).filter(Boolean).reduce((sum, line) => {
    const [added, removed] = line.split('\t')
    return sum + (Number(added) || 0) + (Number(removed) || 0)
  }, 0)
  if (changedLines > 220) {
    await rejectDirtyWorktree(repoDir, input, { reason: `sebcastwall_change_too_large:${changedLines}_lines` })
    throw new Error(`Sebcastwall SEO safety gate allows at most 220 changed lines, got ${changedLines}`)
  }

  const diff = await run('git', ['diff', '-U0', '--', '.'], repoDir)
  const changedContent = String(diff.stdout || '').split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line)).join('\n')
  if (/(priceValue|priceLabel|priceText|priceSubtext|priceNote)|\b\d[\d ]{2,}\s*(kr|sek)\b/i.test(changedContent)) {
    await rejectDirtyWorktree(repoDir, input, { reason: 'sebcastwall_pricing_change_requires_operator' })
    throw new Error('Sebcastwall SEO safety gate blocks pricing changes')
  }

  return { ok: true, profile: 'sebcastwall_seo_only', changedFiles: changed.map((item) => item.path), changedLines }
}

function isSebcastwallAction(input, name = '') {
  return [
    name,
    input?.workspaceSlug,
    input?.projectSlug,
    input?.repoFullName,
    input?.targetUrl,
    input?.gscProperty
  ].filter(Boolean).join(' ').toLowerCase().includes('sebcastwall')
}

function safeBranchPart(value) {
  return String(value || 'seo-change')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `seo-change-${Date.now()}`
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
    '- Work only in the isolated action branch prepared by the runner. Never commit or push yourself; the runner reviews and delivers the result.',
    '- Do not touch unrelated files.',
    '- Do not change deploy config, auth, API integrations, pricing, redirects, or routing unless the action explicitly requires it.',
    '- Prefer metadata, copy, schema, internal links, FAQ, or small existing-page changes.',
    '- If the action text contains a generic template that conflicts with the workspace rules, rewrite the implementation around the workspace rules instead of copying the template.',
    '- Do not add B2B/SMB/konsult/SaaS language to consumer utilities such as vagkollen.se or parkeringspolaren.se.',
    '- Do not repeat a previously completed page/keyword experiment unless the action provides new evidence or a clearly different hypothesis.',
    '- If the keyword is broad, one-word, or weakly evidenced, make only a conservative improvement tied to the actual user intent of the site.',
    '- Leave the repo buildable.',
    ...(isSebcastwallAction(input, repoName) ? [
      '- Sebcastwall design is approved and frozen. Do not redesign sections or change layout, CSS, images, navigation, shared components, forms, CTA behavior, prices, routes or public customer claims.',
      '- For Sebcastwall, focus on evidence-backed SEO only: metadata, search-intent copy, headings without structural JSX changes, internal links, schema or article content.',
      '- Use current canonical routes. Never target /tjanster or /tjanster/app-webbutveckling; use /foretag, /privatpersoner, /tjanster/webbutveckling and /tjanster/mobilappar as appropriate.',
      '- Existing commercial pages should be strengthened, not expanded with generic sections. New service pages require operator approval.',
      '- Never prepend or force an exact-match keyword into a title, H1 or meta description merely because a monitor says it is absent. Preserve page intent and natural Swedish; require positive GSC query evidence or verified Keyword Planner demand.'
    ] : []),
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
      'Use /evenemang as the canonical event listing URL. Do not add internal links to the legacy /events alias; point links to /evenemang or specific canonical event/category pages.',
      'Avoid agency, integration and software-consultancy angles unless explicitly requested.',
    ].join(' ')
  }
  if (/sebcastwall/.test(haystack)) {
    return [
      'sebcastwall.se is an AI/coding/automation consultancy.',
      'The approved structure has separate business and consumer tracks at /foretag and /privatpersoner.',
      'Business priorities are AI reviews, AI education, AI agents, AI automation, web development, mobile apps, internal tools, digital marketing and Microsoft 365. Integrations are supporting work, not the primary position.',
      'The consumer track is Hem-IT in Bromma/Stockholm for computers, Wi-Fi, TV, cameras, accounts/BankID and home-office equipment.',
      'Canonical development routes are /tjanster/webbutveckling and /tjanster/mobilappar. /tjanster/app-webbutveckling and /tjanster are legacy redirects and must not be SEO targets.',
      'The visual design, shared sections, navigation, forms and current public prices are approved and frozen. SEO work must preserve them.',
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
