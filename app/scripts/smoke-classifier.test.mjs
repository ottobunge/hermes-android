// node --test scripts/smoke-classifier.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyPageErrors, KNOWN_LOOP_LIMIT_PER_PHASE, KNOWN_LOOP_MESSAGE } from './smoke-classifier.mjs'

// Shape captured from the production build (2026-10-23).
const baselineStack = [
  `Error: ${KNOWN_LOOP_MESSAGE}`,
  '    at http://127.0.0.1:4174/assets/capabilities-B1fqOH3C.js:4:1991',
  '    at t_ (http://127.0.0.1:4174/assets/capabilities-B1fqOH3C.js:4:5812)'
].join('\n')

const baseline = phase => ({ phase, message: KNOWN_LOOP_MESSAGE, stack: baselineStack })

test('baseline-shaped errors within the bound are tolerated', () => {
  const errors = [...Array(7)].map(() => baseline('tablet')).concat([...Array(6)].map(() => baseline('phone')))

  assert.deepEqual(classifyPageErrors(errors), { tolerated: { tablet: 7, phone: 6 }, problems: [] })
})

test('the same message from an unrelated stack fails', () => {
  const unrelated = {
    phase: 'tablet',
    message: KNOWN_LOOP_MESSAGE,
    stack: `Error: ${KNOWN_LOOP_MESSAGE}\n    at unrelatedAndroidRegression (<anonymous>:4:15)`
  }
  const { problems } = classifyPageErrors([baseline('tablet'), unrelated])

  assert.equal(problems.length, 1)
  assert.match(problems[0], /unrelatedAndroidRegression/)
})

test('a capabilities frame below an unrelated top frame still fails', () => {
  const buried = { phase: 'phone', message: KNOWN_LOOP_MESSAGE, stack: baselineStack.replace('    at http', '    at other (http://x/assets/index-1.js:1:1)\n    at http') }

  assert.equal(classifyPageErrors([buried]).problems.length, 1)
})

test('more than the bound fails', () => {
  const errors = [...Array(KNOWN_LOOP_LIMIT_PER_PHASE + 1)].map(() => baseline('phone'))
  const { problems } = classifyPageErrors(errors)

  assert.equal(problems.length, 1)
  assert.match(problems[0], /exceeds the bound/)
})

test('onboarding gets no allowance', () => {
  assert.equal(classifyPageErrors([baseline('onboarding')]).problems.length, 1)
})

test('any other message fails', () => {
  const other = { phase: 'tablet', message: 'Cannot read properties of undefined', stack: baselineStack }

  assert.equal(classifyPageErrors([other]).problems.length, 1)
})
