import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workerSource = readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8')
const runtimeSource = readFileSync(new URL('../seo-runtime/src/server.mjs', import.meta.url), 'utf8')
const runnerSource = readFileSync(new URL('./codex-runner.mjs', import.meta.url), 'utf8')
const promoterSource = readFileSync(new URL('./review-promoter.mjs', import.meta.url), 'utf8')
const repoHealthSource = readFileSync(new URL('./repo-health-check.mjs', import.meta.url), 'utf8')

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
})

test('blocked backlog actions do not fall back to opportunity scout', () => {
  assert.doesNotMatch(workerSource, /synthetic_backlog_fallback_to_scout/)
  assert.doesNotMatch(workerSource, /function shouldScoutAfterBlockedBacklog/)
  assert.match(workerSource, /blocked-backlog/)
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
})

test('repo health requires exact local and remote sync', () => {
  assert.match(repoHealthSource, /rev-list/)
  assert.match(repoHealthSource, /unpushed_commits/)
})

test('workspace identity prefers a canonical repository key', () => {
  assert.match(workerSource, /workspace-identity\.mjs/)
  assert.match(workerSource, /migrateWorkspaceIdentities\(workspaces\)/)
})
