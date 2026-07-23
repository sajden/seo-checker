import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workerSource = readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8')

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
