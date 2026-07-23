import test from 'node:test'
import assert from 'node:assert/strict'
import { requestsVisualChangeText, requiresOperatorProposalText } from './operator-proposal-policy.mjs'

test('blocks a requested CTA or design change', () => {
  assert.equal(requiresOperatorProposalText('Ändra CTA och layout på sidan.'), true)
})

test('allows metadata work that explicitly preserves CTA and design', () => {
  assert.equal(
    requiresOperatorProposalText('Uppdatera title och meta. Bevara CTA, design och layout.'),
    false
  )
})

test('allows metadata work without changing protected surfaces', () => {
  assert.equal(
    requiresOperatorProposalText('Lägg Stockholm-vinkel i metadata utan att ändra CTA, priser eller formulär.'),
    false
  )
  assert.equal(
    requiresOperatorProposalText('Skicka renderServerH1 till sidan så den får en server-renderad H1 utan layoutändring.'),
    false
  )
})

test('classifies a requested visual change separately', () => {
  assert.equal(requestsVisualChangeText('Ändra layout och bilder på sidan.'), true)
  assert.equal(requestsVisualChangeText('Ändra metadata men behåll layout och bilder.'), false)
  assert.equal(requestsVisualChangeText('Lägg till H1 utan layoutändring.'), false)
  assert.equal(requestsVisualChangeText('Lämna sidans visuella innehåll och CTA oförändrade.'), false)
})
