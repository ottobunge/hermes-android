// node --test scripts/smoke-classifier.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyPageErrors,
  findGuardSite,
  KNOWN_LOOP_LIMIT_PER_PHASE,
  KNOWN_LOOP_MESSAGE
} from './smoke-classifier.mjs'

// Shapes captured from the production build (2026-10-23): the guard's
// `Error(` is at capabilities-B1fqOH3C.js:4:1991 and every baseline error's
// top frame is exactly that location.
const site = { file: 'capabilities-B1fqOH3C.js', line: 4, column: 1991 }
const frame = (location, name) =>
  name ? `    at ${name} (http://127.0.0.1:4174/assets/${location})` : `    at http://127.0.0.1:4174/assets/${location}`
const stackAt = (location, name) =>
  [`Error: ${KNOWN_LOOP_MESSAGE}`, frame(location, name), frame('capabilities-B1fqOH3C.js:4:5812', 't_')].join('\n')

const baseline = phase => ({ phase, message: KNOWN_LOOP_MESSAGE, stack: stackAt('capabilities-B1fqOH3C.js:4:1991') })

test('findGuardSite locates the single guard Error( in the built assets', () => {
  const guard = `if(++o.current>50)throw o.current=0,Error(\`${KNOWN_LOOP_MESSAGE}\`);`
  const assets = [
    { name: 'index-1.js', source: 'console.log(1)' },
    { name: 'capabilities-X.js', source: `a\nb\nc\n${'x'.repeat(10)}${guard}` }
  ]

  assert.deepEqual(findGuardSite(assets), {
    file: 'capabilities-X.js',
    line: 4,
    column: 10 + guard.indexOf('Error(') + 1
  })
})

test('findGuardSite reports `new Error(` at `new`', () => {
  const source = `;throw new Error("${KNOWN_LOOP_MESSAGE}")`

  assert.deepEqual(findGuardSite([{ name: 'a.js', source }]), { file: 'a.js', line: 1, column: 8 })
})

test('findGuardSite fails closed on zero or several candidates', () => {
  const guard = `Error(\`${KNOWN_LOOP_MESSAGE}\`)`

  assert.equal(findGuardSite([{ name: 'a.js', source: 'nothing here' }]), null)
  assert.equal(findGuardSite([{ name: 'a.js', source: guard }, { name: 'b.js', source: guard }]), null)
})

test('baseline-shaped errors at the guard site within the bound are tolerated', () => {
  const errors = [...Array(7)].map(() => baseline('tablet')).concat([...Array(6)].map(() => baseline('phone')))

  assert.deepEqual(classifyPageErrors(errors, site), { tolerated: { tablet: 7, phone: 6 }, problems: [] })
})

test('same message, same capabilities chunk, different function/location fails', () => {
  const sameChunk = [
    { phase: 'tablet', message: KNOWN_LOOP_MESSAGE, stack: stackAt('capabilities-B1fqOH3C.js:32:127', 'unrelatedCallback') },
    { phase: 'tablet', message: KNOWN_LOOP_MESSAGE, stack: stackAt('capabilities-B1fqOH3C.js:4:1990') },
    { phase: 'phone', message: KNOWN_LOOP_MESSAGE, stack: stackAt('capabilities-B1fqOH3C.js:4:19910') },
    // the guard location in a different file (another build's chunk)
    { phase: 'phone', message: KNOWN_LOOP_MESSAGE, stack: stackAt('capabilities-OTHER.js:4:1991') }
  ]

  assert.equal(classifyPageErrors(sameChunk, site).problems.length, 4)
})

test('the same message from an unrelated stack fails', () => {
  const unrelated = {
    phase: 'tablet',
    message: KNOWN_LOOP_MESSAGE,
    stack: `Error: ${KNOWN_LOOP_MESSAGE}\n    at unrelatedAndroidRegression (<anonymous>:4:15)`
  }
  const { problems } = classifyPageErrors([baseline('tablet'), unrelated], site)

  assert.equal(problems.length, 1)
  assert.match(problems[0], /unrelatedAndroidRegression/)
})

test('a guard frame below an unrelated top frame still fails', () => {
  const buried = {
    phase: 'phone',
    message: KNOWN_LOOP_MESSAGE,
    stack: [`Error: ${KNOWN_LOOP_MESSAGE}`, frame('index-1.js:1:1', 'other'), frame('capabilities-B1fqOH3C.js:4:1991')].join(
      '\n'
    )
  }

  assert.equal(classifyPageErrors([buried], site).problems.length, 1)
})

test('no identified guard site means no allowance', () => {
  const { tolerated, problems } = classifyPageErrors([baseline('tablet')], null)

  assert.deepEqual(tolerated, {})
  assert.match(problems[0], /no guard site identified/)
})

test('more than the bound fails', () => {
  const errors = [...Array(KNOWN_LOOP_LIMIT_PER_PHASE + 1)].map(() => baseline('phone'))
  const { problems } = classifyPageErrors(errors, site)

  assert.equal(problems.length, 1)
  assert.match(problems[0], /exceeds the bound/)
})

test('onboarding gets no allowance', () => {
  assert.equal(classifyPageErrors([baseline('onboarding')], site).problems.length, 1)
})

test('any other message fails', () => {
  const other = { phase: 'tablet', message: 'Cannot read properties of undefined', stack: baseline('tablet').stack }

  assert.equal(classifyPageErrors([other], site).problems.length, 1)
})
