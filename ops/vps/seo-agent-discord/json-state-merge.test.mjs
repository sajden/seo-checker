import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeJsonChanges } from './json-state-merge.mjs'

test('preserves a concurrent runtime queue update during an unrelated worker save', () => {
  const baseline = { queue: {}, lessons: [] }
  const worker = { queue: {}, lessons: ['worker lesson'] }
  const runtime = { queue: { action1: { status: 'approved' } }, lessons: [] }
  assert.deepEqual(mergeJsonChanges(baseline, worker, runtime), {
    queue: { action1: { status: 'approved' } },
    lessons: ['worker lesson']
  })
})

test('applies nested worker changes without removing a concurrent runtime result', () => {
  const baseline = { results: { old: { status: 'review_ready' } }, heartbeat: 1 }
  const worker = { results: { old: { status: 'rejected' } }, heartbeat: 1 }
  const runtime = {
    results: {
      old: { status: 'review_ready' },
      new: { status: 'completed' }
    },
    heartbeat: 2
  }
  assert.deepEqual(mergeJsonChanges(baseline, worker, runtime), {
    results: {
      old: { status: 'rejected' },
      new: { status: 'completed' }
    },
    heartbeat: 2
  })
})

test('propagates intentional deletions while retaining unrelated keys', () => {
  const baseline = { queue: { remove: true, keep: true }, runtime: { healthy: true } }
  const worker = { queue: { keep: true }, runtime: { healthy: true } }
  const latest = { queue: { remove: true, keep: true }, runtime: { healthy: true, tick: 4 } }
  assert.deepEqual(mergeJsonChanges(baseline, worker, latest), {
    queue: { keep: true },
    runtime: { healthy: true, tick: 4 }
  })
})
