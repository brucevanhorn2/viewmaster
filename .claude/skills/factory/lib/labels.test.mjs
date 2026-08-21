import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FACTORY_LABELS, isFactoryLabel, computeLabelTransition } from './labels.mjs'

test('FACTORY_LABELS has exactly the 8 expected stage labels', () => {
  assert.deepEqual(FACTORY_LABELS, [
    'factory:queued',
    'factory:brainstorming',
    'factory:plan-ready',
    'factory:executing',
    'factory:awaiting-push',
    'factory:in-review',
    'factory:ready-to-merge',
    'factory:needs-attention'
  ])
})

test('isFactoryLabel only matches factory: prefixed labels', () => {
  assert.equal(isFactoryLabel('factory:queued'), true)
  assert.equal(isFactoryLabel('bug'), false)
})

test('computeLabelTransition removes the old factory label and adds the new one', () => {
  const result = computeLabelTransition(['bug', 'factory:queued'], 'factory:brainstorming')
  assert.deepEqual(result, { toRemove: ['factory:queued'], toAdd: ['factory:brainstorming'] })
})

test('computeLabelTransition is a no-op when the issue already has the target label', () => {
  const result = computeLabelTransition(['factory:executing'], 'factory:executing')
  assert.deepEqual(result, { toRemove: [], toAdd: [] })
})

test('computeLabelTransition leaves non-factory labels untouched', () => {
  const result = computeLabelTransition(['bug', 'help wanted'], 'factory:queued')
  assert.deepEqual(result, { toRemove: [], toAdd: ['factory:queued'] })
})

test('computeLabelTransition rejects a non-factory target label', () => {
  assert.throws(() => computeLabelTransition([], 'bug'), /Not a factory label/)
})
