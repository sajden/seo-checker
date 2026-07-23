import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalRepoFullName, workspaceProfileKey } from './workspace-identity.mjs'

test('uses repoFullName as the stable workspace identity', () => {
  assert.equal(workspaceProfileKey({
    id: 'sc-domain:sebcastwall.se__sajden/sebcastwall__main',
    repoFullName: 'sajden/sebcastwall'
  }), 'repo:sajden/sebcastwall')
})

test('extracts repository identity from historical composite ids', () => {
  assert.equal(canonicalRepoFullName({
    id: 'sc-domain:sebcastwall.se__sajden/sebcastwall__main'
  }), 'sajden/sebcastwall')
  assert.equal(canonicalRepoFullName({
    id: 'https://vagkollen.se/__sajden/vagkollen__main'
  }), 'sajden/vagkollen')
})

test('repairs a previously malformed migrated key', () => {
  assert.equal(canonicalRepoFullName({
    workspaceKey: 'repo:sebcastwall.se__sajden/sebcastwall__main'
  }), 'sajden/sebcastwall')
})
