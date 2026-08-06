import assert from 'node:assert/strict'
import test from 'node:test'

import { applyIssueHysteresis } from './chain-health-policy.mjs'

const mapIssue = { id: 'live-parkeringspolaren-map-desktop', label: 'Map', detail: 'timeout' }

test('a live browser issue must fail three consecutive checks before alerting', () => {
  let state = {}
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = applyIssueHysteresis([mapIssue], state)
    assert.deepEqual(result.activeIds, [])
    state = { activeIssues: result.activeIssues, issueObservations: result.issueObservations }
  }
  const result = applyIssueHysteresis([mapIssue], state)
  assert.deepEqual(result.activeIds, [mapIssue.id])
  assert.deepEqual(result.newlyActiveIds, [mapIssue.id])
})

test('a transient live browser failure is forgotten after a healthy check', () => {
  const failed = applyIssueHysteresis([mapIssue], {})
  const healthy = applyIssueHysteresis([], {
    activeIssues: failed.activeIssues,
    issueObservations: failed.issueObservations
  })
  const failedAgain = applyIssueHysteresis([mapIssue], {
    activeIssues: healthy.activeIssues,
    issueObservations: healthy.issueObservations
  })
  assert.deepEqual(failedAgain.activeIds, [])
  assert.equal(failedAgain.issueObservations[mapIssue.id].failureCount, 1)
})

test('an active issue needs two healthy checks before recovery', () => {
  const activeState = {
    activeIssues: [mapIssue],
    issueObservations: {
      [mapIssue.id]: { lastObserved: 'failing', failureCount: 3, successCount: 0 }
    }
  }
  const firstHealthy = applyIssueHysteresis([], activeState)
  assert.deepEqual(firstHealthy.activeIds, [mapIssue.id])
  const secondHealthy = applyIssueHysteresis([], {
    activeIssues: firstHealthy.activeIssues,
    issueObservations: firstHealthy.issueObservations
  })
  assert.deepEqual(secondHealthy.activeIds, [])
  assert.deepEqual(secondHealthy.recoveredIds, [mapIssue.id])
})

test('non-browser service failures remain immediate', () => {
  const issue = { id: 'seo-runtime-health', label: 'Runtime', detail: 'down' }
  const result = applyIssueHysteresis([issue], {})
  assert.deepEqual(result.activeIds, [issue.id])
})
