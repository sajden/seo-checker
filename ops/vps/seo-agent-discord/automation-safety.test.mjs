import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workerSource = readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8')
const runtimeSource = readFileSync(new URL('../seo-runtime/src/server.mjs', import.meta.url), 'utf8')
const runnerSource = readFileSync(new URL('./codex-runner.mjs', import.meta.url), 'utf8')
const promoterSource = readFileSync(new URL('./review-promoter.mjs', import.meta.url), 'utf8')
const repoHealthSource = readFileSync(new URL('./repo-health-check.mjs', import.meta.url), 'utf8')
const watchdogSource = readFileSync(new URL('./chain-health-watchdog.mjs', import.meta.url), 'utf8')
const deploySource = readFileSync(new URL('./deploy-release.sh', import.meta.url), 'utf8')
const autoDeploySource = readFileSync(new URL('./auto-deploy.sh', import.meta.url), 'utf8')

test('autonomous code and self-repair require explicit opt-in', () => {
  assert.match(
    workerSource,
    /const autonomousCodeEnabled = env\.SEO_AGENT_AUTONOMOUS_CODE_ENABLED === 'true'/
  )
  assert.match(
    workerSource,
    /const selfRepairEnabled = env\.SEO_AGENT_SELF_REPAIR_ENABLED === 'true'/
  )
})

test('an autonomous daily limit of zero disables queueing instead of becoming unlimited', () => {
  assert.match(workerSource, /if \(autonomousCodePerWorkspacePerDay <= 0\) return/)
  assert.doesNotMatch(workerSource, /autonomousCodePerWorkspacePerDay > 0 && usedToday/)
})

test('worker analysis calls cannot bypass the sandbox', () => {
  assert.doesNotMatch(workerSource, /dangerously-bypass-approvals-and-sandbox/)
  assert.match(workerSource, /--sandbox read-only/)
})

test('self-repair requires both approved code automation and self-repair opt-in', () => {
  const guardedCalls = workerSource.match(/if \(codeAutomationEnabled && selfRepairEnabled\)/g) || []
  assert.equal(guardedCalls.length, 2)
})

test('startup reconciles stale transitional ledger statuses', () => {
  assert.match(workerSource, /ensureAutonomousAgentState\(\)\s+reconcileTransitionalLedgerStatuses\(\)/)
  assert.match(workerSource, /migrateWorkspaceIdentities\(workspaces\)\s+reconcileTransitionalLedgerStatuses\(\)/)
  assert.match(workerSource, /coding_started/)
})

test('blocked backlog actions do not fall back to opportunity scout', () => {
  assert.doesNotMatch(workerSource, /synthetic_backlog_fallback_to_scout/)
  assert.doesNotMatch(workerSource, /function shouldScoutAfterBlockedBacklog/)
  assert.match(workerSource, /blocked-backlog/)
})

test('live guard rejections block opportunity scout before Codex', () => {
  assert.match(workerSource, /function shouldSkipCodexOpportunityScoutForLiveRejections/)
  assert.match(workerSource, /live_rejections_waiting_recheck_or_guard/)
  assert.match(workerSource, /if \(shouldSkipCodexOpportunityScoutForLiveRejections\(pending, rejectionReasons\)\)/)
  assert.match(workerSource, /if \(shouldSkipCodexOpportunityScoutForLiveRejections\(context\.pending \|\| \[\], context\.rejectionReasons \|\| \[\]\)\)/)
})

test('runtime mutations require bearer authentication', () => {
  assert.match(runtimeSource, /runtime_auth_not_configured/)
  assert.match(runtimeSource, /isAuthorizedRuntimeRequest/)
  assert.match(workerSource, /authorization: `Bearer \$\{seoRuntimeToken\}`/)
})

test('worker and runtime use locked three-way state persistence', () => {
  assert.match(workerSource, /mergeJsonChanges\(stateBaseline, state, latest\)/)
  assert.match(runtimeSource, /mergeJsonChanges\(baseline, state, latest\)/)
  assert.match(workerSource, /stateLockPath/)
  assert.match(runtimeSource, /stateLockPath/)
})

test('all heavy code and promotion work shares one capacity lock', () => {
  assert.match(runnerSource, /acquireHeavyWorkCapacity/)
  assert.match(promoterSource, /acquireHeavyWorkCapacity/)
})

test('configured production deploy is verified before main is pushed', () => {
  const deployIndex = promoterSource.indexOf('await runConfiguredProductionDeploy(repoDir)')
  const pushIndex = promoterSource.indexOf("await run('git', ['push', 'origin', `HEAD:${baseBranch}`]")
  assert.ok(deployIndex >= 0)
  assert.ok(pushIndex > deployIndex)
  assert.match(promoterSource, /restoreProductionFromMain/)
  assert.match(promoterSource, /process\.env\.CLOUDFLARE_API_TOKEN/)
})

test('an interrupted approved promotion is retried without asking for approval again', () => {
  assert.match(workerSource, /\['promotion_running', 'operator_approved'\]/)
  assert.match(workerSource, /status: 'operator_approved'/)
  assert.match(workerSource, /interrupted_promotion_retry_failed/)
  assert.match(workerSource, /!record\?\.operatorApprovedAt/)
})

test('repo health requires exact local and remote sync', () => {
  assert.match(repoHealthSource, /rev-list/)
  assert.match(repoHealthSource, /unpushed_commits/)
})

test('workspace identity prefers a canonical repository key', () => {
  assert.match(workerSource, /workspace-identity\.mjs/)
  assert.match(workerSource, /migrateWorkspaceIdentities\(workspaces\)/)
})

test('worker and runtime enforce the same configurable review capacity', () => {
  assert.match(workerSource, /reviewCapacityCheck/)
  assert.match(runtimeSource, /reviewCapacityCheck/)
  assert.match(runtimeSource, /SEO_AGENT_MAX_PENDING_REVIEWS_PER_WORKSPACE/)
})

test('completed action ids cannot be queued again', () => {
  assert.match(workerSource, /An action id identifies one immutable proposal/)
  assert.match(workerSource, /if \(status === 'archived_failed'\) return false\s+\/\//)
})

test('pending review branches are reminded in Discord', () => {
  assert.match(workerSource, /remindPendingCodeReviews\(workspaces\)/)
  assert.match(workerSource, /pending_code_review_reminded/)
})

test('Codex rewrites must provide a final target URL', () => {
  assert.match(workerSource, /codexBrief\.decision === 'rewrite'/)
  assert.match(workerSource, /targetUrl.*slutlig https-URL/)
})

test('production releases are tested, health checked and rollback capable', () => {
  assert.match(deploySource, /node --test/)
  assert.match(deploySource, /rollback\(\)/)
  assert.match(deploySource, /healthz/)
  assert.match(deploySource, /\.release\.json/)
  assert.match(deploySource, /sha256/)
})

test('automatic deploys use immutable commit checkouts and drift monitoring', () => {
  assert.match(autoDeploySource, /CHECKOUT="\$SOURCE_ROOT\/\$TARGET"/)
  assert.match(autoDeploySource, /checkout --quiet --detach/)
  assert.doesNotMatch(autoDeploySource, /reset --hard/)
  assert.match(autoDeploySource, /crypto\.createHash\("sha256"\)/)
  assert.match(watchdogSource, /checkReleaseIntegrity/)
  assert.match(watchdogSource, /release-code-drift/)
  assert.match(watchdogSource, /seo-agent-auto-deploy\.service/)
})
