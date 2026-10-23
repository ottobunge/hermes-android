// node --test scripts/smoke-classifier.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyPageErrors } from './smoke-classifier.mjs'

const GET_SNAPSHOT =
  'Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.'
const MARK_DIRTY =
  'Maximum update depth exceeded. This can happen when a resource repeatedly calls setState inside useEffect.'

// Exactly the shape the round 3–9 classifier used to TOLERATE: the tap
// guard's own throw site in the production build, connected phase, in bound.
const formerlyTolerated = phase => ({
  phase,
  message: GET_SNAPSHOT,
  stack: `Error: ${GET_SNAPSHOT}\n    at http://127.0.0.1:4174/assets/capabilities-B1fqOH3C.js:4:1991`
})

test('no page errors → no problems', () => {
  assert.deepEqual(classifyPageErrors([]), { problems: [] })
})

test('the formerly tolerated getSnapshot loop now fails, in every phase', () => {
  for (const phase of ['tablet', 'phone', 'onboarding']) {
    const { problems } = classifyPageErrors([formerlyTolerated(phase)])

    assert.equal(problems.length, 1)
    assert.match(problems[0], new RegExp(`^\\[${phase}\\] render-loop regression`))
    assert.match(problems[0], /capabilities-B1fqOH3C\.js:4:1991/)
  }
})

test('a single occurrence fails — there is no count allowance', () => {
  assert.equal(classifyPageErrors([formerlyTolerated('tablet')]).problems.length, 1)
})

test('the markDirty variant (typing) fails as a render-loop regression', () => {
  const { problems } = classifyPageErrors([
    { phase: 'phone', message: MARK_DIRTY, stack: `Error: ${MARK_DIRTY}\n    at qg.markDirty (http://x/assets/capabilities-1.js:4:3887)` }
  ])

  assert.match(problems[0], /render-loop regression/)
})

test('every error is reported, one problem each, other errors as plain pageerrors', () => {
  const { problems } = classifyPageErrors([
    formerlyTolerated('tablet'),
    formerlyTolerated('tablet'),
    { phase: 'phone', message: 'Cannot read properties of undefined', stack: '' }
  ])

  assert.equal(problems.length, 3)
  assert.match(problems[2], /^\[phone\] pageerror: Cannot read properties of undefined\n {4}\(no stack\)$/)
})
