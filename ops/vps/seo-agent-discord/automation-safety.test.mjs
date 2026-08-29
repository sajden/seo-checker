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
  assert.match(workerSource, /target_recently_completed_waiting_measurement/)
  assert.match(workerSource, /if \(shouldSkipCodexOpportunityScoutForLiveRejections\(pending, rejectionReasons\)\)/)
  assert.match(workerSource, /if \(shouldSkipCodexOpportunityScoutForLiveRejections\(context\.pending \|\| \[\], context\.rejectionReasons \|\| \[\]\)\)/)
})

test('only a live candidate that survived prior validation blocks synthetic scout', () => {
  assert.match(workerSource, /const rejectedLiveActionIds = new Set/)
  assert.match(workerSource, /if \(rejectedLiveActionIds\.has\(String\(action\?\.id \|\| ''\)\)\) return false/)
  assert.match(workerSource, /if \(hasGoodLiveCandidate\) \{/)
  assert.doesNotMatch(workerSource, /if \(!queueIsWeak && hasGoodLiveCandidate\)/)
})

test('Sebcastwall bypasses static goal gaps and uses the evidence-backed scout', () => {
  assert.match(
    workerSource,
    /let rawAction = isSebcastwallWorkspace\(workspace, profile\)\s+\? null\s+: buildWorkspaceGoalGapAction/
  )
})

test('policy-incompatible opportunity scouts cool down before Codex retries', () => {
  assert.match(workerSource, /previousScoutBlockedReason/)
  assert.match(workerSource, /previousScout\?\.status === 'no_policy_compatible_opportunity'/)
  assert.match(workerSource, /reason: previousScoutBlockedReason \|\| 'recent_invalid_scout'/)
  assert.match(workerSource, /SEO_AGENT_OPPORTUNITY_SCOUT_NO_ACTION_COOLDOWN_MS/)
  assert.match(workerSource, /function shouldBackoffNoActionOpportunityScout/)
  assert.match(workerSource, /previousScout\.status === 'no_policy_compatible_opportunity'/)
  assert.match(workerSource, /reason: 'recent_no_action_scout_backoff'/)
})

test('recent code result targets are removed from opportunity scout evidence before Codex', () => {
  assert.match(workerSource, /const recentCodeResults = recentCodeResultsForWorkspace\(workspace, targetChannelId\)/)
  assert.match(workerSource, /const recentCodeResultBlockedStatuses = new Set\(\['completed', 'no_changes', 'build_failed', 'failed', 'deprioritized', 'blocked', 'rejected', 'review_ready'\]\)/)
  assert.match(workerSource, /Date\.now\(\) - resultAt < completedTargetCooldownMs/)
  assert.match(workerSource, /recentCodeResultBlockedStatuses\.has\(status\)\) excludedTargets\.push\(targetUrl\)/)
  assert.ok(workerSource.indexOf('recentCodeResultBlockedStatuses') < workerSource.indexOf('excludeOpportunityEvidenceTargets(rawEvidenceContext, excludedTargets)'))
  assert.ok(workerSource.indexOf('recentCodeResultBlockedStatuses') < workerSource.indexOf('buildKeywordPlannerDiscoveryEvidence(keywordMap, excludedTargets)'))
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

test('Parkeringspolaren map rendering is verified before main is pushed', () => {
  const visualIndex = promoterSource.indexOf('verifyCriticalProductionExperience(repoFullName)')
  const pushIndex = promoterSource.indexOf("await run('git', ['push', 'origin', `HEAD:${baseBranch}`]")
  assert.ok(visualIndex >= 0)
  assert.ok(pushIndex > visualIndex)
  assert.match(promoterSource, /sajden\/parkeringspolaren-web/)
  assert.match(promoterSource, /data-map-layer-ready/)
  assert.match(promoterSource, /canvas\.mapboxgl-canvas/)
  assert.match(promoterSource, /img\.leaflet-tile/)
  assert.match(promoterSource, /naturalWidth > 0/)
  assert.match(promoterSource, /name: 'desktop'/)
  assert.match(promoterSource, /name: 'mobil'/)
})

test('Discord worker passes its loaded Cloudflare token to review promotion', () => {
  assert.match(workerSource, /CLOUDFLARE_API_TOKEN: env\.CLOUDFLARE_API_TOKEN/)
})

test('Discord worker passes the public Mapbox build configuration to review promotion', () => {
  assert.match(workerSource, /NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: env\.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN/)
  assert.match(workerSource, /NEXT_PUBLIC_MAPBOX_STYLE: env\.NEXT_PUBLIC_MAPBOX_STYLE/)
})

test('repository tests run before an approved SEO branch is built', () => {
  const testIndex = promoterSource.indexOf("await run('npm', ['test']")
  const buildIndex = promoterSource.indexOf("await run('npm', ['run', 'build']")
  assert.ok(testIndex >= 0)
  assert.ok(buildIndex > testIndex)
})

test('an interrupted approved promotion is retried without asking for approval again', () => {
  assert.match(workerSource, /\['promotion_running', 'operator_approved'\]/)
  assert.match(workerSource, /status: 'operator_approved'/)
  assert.match(workerSource, /interrupted_promotion_retry_failed/)
  assert.match(workerSource, /!record\?\.operatorApprovedAt/)
  assert.match(workerSource, /const mainCommit = String\(completedResult\.commit \|\| commit\)/)
  assert.match(workerSource, /Commit på main: \$\{mainCommit\}/)
})

test('repo health requires exact local and remote sync', () => {
  assert.match(repoHealthSource, /rev-list/)
  assert.match(repoHealthSource, /unpushed_commits/)
})

test('automation readiness accepts a clean pending review branch', () => {
  assert.match(workerSource, /branch=\\"\$\(git -C \\"\$dir\\" branch --show-current\)\\"/)
  assert.match(workerSource, /push --dry-run origin \\"HEAD:\$target\\"/)
  const queueFunction = workerSource.slice(
    workerSource.indexOf('async function maybeQueueAutonomousCodeActions'),
    workerSource.indexOf('function autonomousWorkspaceOrder')
  )
  assert.ok(queueFunction.indexOf('activeActionBlocksAutonomousCode') < queueFunction.indexOf('repoAutomationReady'))
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
  assert.match(workerSource, /clearReviewComponentsForAction\(actionId, targetChannelId\)/)
  assert.match(workerSource, /pending_code_review_previous_card_clear_failed/)
  assert.match(workerSource, /Det här är inte ett nytt förslag/)
  assert.match(workerSource, /pending_code_review_reminded/)
})

test('old Discord controls cannot execute archived SEO work', () => {
  assert.match(workerSource, /messageAgeMs > 14 \* 24 \* 60 \* 60 \* 1000/)
  assert.match(workerSource, /SEO-kortet är arkiverat/)
})

test('article review cards use a dedicated Discord channel and explain search intent', () => {
  assert.match(workerSource, /SEO_AGENT_ARTICLE_REVIEW_CHANNEL_NAME \|\| 'artikelgranskning'/)
  assert.match(workerSource, /type !== 'article' && type !== 'article_publish'/)
  assert.match(workerSource, /Sökintention bakom frasen:/)
  assert.match(workerSource, /Artikeln hjälper läsaren att:/)
  assert.match(workerSource, /CTA:/)
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

test('chain health verifies a real production map in desktop and mobile Chrome', () => {
  assert.match(watchdogSource, /checkCriticalLiveExperiences/)
  assert.match(watchdogSource, /parkeringspolaren\.se\/sv\/mc-parkering-jonkoping/)
  assert.match(watchdogSource, /data-map-layer-ready/)
  assert.match(watchdogSource, /canvas\.mapboxgl-canvas/)
  assert.match(watchdogSource, /img\.leaflet-tile/)
  assert.match(watchdogSource, /asset\.naturalWidth > 0/)
  assert.match(watchdogSource, /name: 'desktop'/)
  assert.match(watchdogSource, /name: 'mobil'/)
  assert.match(watchdogSource, /seo-heavy-work-global\.json/)
  assert.match(watchdogSource, /MemAvailable/)
  assert.match(watchdogSource, /element\.scrollIntoView/)
  assert.doesNotMatch(watchdogSource, /scrollIntoViewIfNeeded/)
})

test('chain health debounces intermittent live-browser failures', () => {
  assert.match(watchdogSource, /applyIssueHysteresis/)
  assert.match(watchdogSource, /SEO_AGENT_CHAIN_LIVE_FAILURE_THRESHOLD \|\| 3/)
  assert.match(watchdogSource, /SEO_AGENT_CHAIN_RECOVERY_THRESHOLD \|\| 2/)
})

test('ranking reviews distinguish research ideas from actual code work', () => {
  assert.match(workerSource, /Status: research-kandidat/)
  assert.match(workerSource, /Ingen kodändring eller branch har skapats av denna review/)
  assert.match(workerSource, /eligibleLiveActionCount/)
  assert.doesNotMatch(workerSource, /if \(review\.weakLiveQueue && review\.next\?\.type === 'keyword_gap'\) return true/)
})

test('Swedish SEO copy does not preserve awkward English grammar for exact match', () => {
  assert.match(runnerSource, /använder inte engelsk plural/)
  assert.match(runnerSource, /Do not preserve English plural forms/)
})

test('cosmetic synonym-only SEO diffs are blocked deterministically', () => {
  assert.match(runnerSource, /deterministicMaterialityReview\(input, diff\.stdout\)/)
  assert.match(runnerSource, /similarity < 0\.88/)
  assert.match(runnerSource, /utan materiellt nytt SEO-värde/)
})

test('target history and rejected actions use a ninety day guard', () => {
  assert.match(workerSource, /SEO_AGENT_COMPLETED_TARGET_COOLDOWN_MS \|\| String\(90 \* 24 \* 60 \* 60 \* 1000\)/)
  assert.match(workerSource, /ledger\?\.status === 'rejected' && !isLedgerRecheckDue\(ledger\)/)
  assert.match(workerSource, /status === 'completed' \|\| status === 'rejected'/)
})

test('verified evidence provenance survives synthetic action enrichment', () => {
  assert.match(workerSource, /evidenceSource: rawAction\.evidenceSource \|\|/)
  assert.match(workerSource, /checkActionEvidenceIntegrity\(action\)/)
  assert.match(workerSource, /gsc_claim_without_gsc_provenance/)
  assert.match(workerSource, /fresh_evidence_is_stale/)
})

test('approved runtime queue is revalidated immediately before execution', () => {
  const processStart = workerSource.indexOf('async function processApprovedCodeActions')
  const runtimeStart = workerSource.indexOf('const runtimeRun = await runNextApprovedCodeActionThroughRuntime()', processStart)
  const policyRecheck = workerSource.indexOf('prunePolicyIncompatibleApprovedQueue(workspaces)', processStart)
  assert.ok(processStart >= 0 && policyRecheck > processStart && policyRecheck < runtimeStart)
  assert.match(workerSource, /pre_runtime_policy_recheck/)
  assert.match(workerSource, /approved_queue_pruned_by_policy/)
})
