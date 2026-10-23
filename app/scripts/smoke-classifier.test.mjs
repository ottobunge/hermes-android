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

test('console: an error-boundary report is a problem', async () => {
  const { classifyConsoleError } = await import('./smoke-classifier.mjs')
  const text = `[error-boundary:contrib:workspace] Error: ${GET_SNAPSHOT}\n    at http://127.0.0.1:4174/assets/capabilities-1.js:4:1991`

  assert.match(classifyConsoleError(text), /^error boundary caught a render error: \[error-boundary:contrib:workspace\]/)
  assert.match(classifyConsoleError('[error-boundary] TypeError: x is undefined'), /error boundary caught/)
})

test('console: a caught render-loop error logged by React is a problem', async () => {
  const { classifyConsoleError } = await import('./smoke-classifier.mjs')

  assert.match(classifyConsoleError(`Error: ${GET_SNAPSHOT}\n    at …`), /render-loop regression/)
  assert.match(classifyConsoleError(`Error: ${MARK_DIRTY}`), /render-loop regression/)
})

test('console: unrelated HTTP resource diagnostics are not problems', async () => {
  const { classifyConsoleError } = await import('./smoke-classifier.mjs')

  assert.equal(classifyConsoleError('Failed to load resource: the server responded with a status of 409 (Conflict)'), null)
  assert.equal(classifyConsoleError('Failed to load resource: net::ERR_CONNECTION_REFUSED'), null)
})
