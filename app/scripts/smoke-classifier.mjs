// Page-error classifier for scripts/smoke.mjs (unit-tested in
// smoke-classifier.test.mjs).
//
// Exactly one failure class is tolerated: upstream's assistant-ui thread-list
// render loop, reproduced in the unmodified upstream Electron app (README
// "Upstream comparison"). A page error counts as that baseline only if ALL of:
//   1. its message is exactly tap's useSyncExternalStore guard message;
//   2. its TOP stack frame is in the built `capabilities-*.js` chunk, where
//      every baseline occurrence originates (that chunk bundles
//      @assistant-ui/tap);
//   3. it happens in a connected-surface phase (onboarding gets no allowance —
//      the thread list isn't mounted there);
//   4. the phase's count stays within KNOWN_LOOP_LIMIT_PER_PHASE.
// Anything else is a problem. Limits of the evidence: the message and the
// top frame identify tap's generic hook, not which resource looped, so a NEW
// loop through the same hook within the bound would still pass. A rebuilt
// chunk with a different name makes the smoke fail loud, never pass silently.

export const KNOWN_LOOP_MESSAGE =
  'Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.'

const KNOWN_LOOP_TOP_FRAME = /^\s*at (?:\S+ \()?\S*\/assets\/capabilities-[\w-]+\.js:\d+:\d+\)?\s*$/

// Observed per phase (page load + 20–100 s): 6–7 in this smoke, 8–9 in a
// reviewer's run, 5 in upstream Electron. The bound is 3x the typical 7.
export const KNOWN_LOOP_BASELINE_PER_PHASE = 7
export const KNOWN_LOOP_LIMIT_PER_PHASE = 3 * KNOWN_LOOP_BASELINE_PER_PHASE

const CONNECTED_PHASES = new Set(['tablet', 'phone'])

function topFrame(stack = '') {
  return (
    String(stack)
      .split('\n')
      .find(line => /^\s*at /.test(line)) ?? ''
  )
}

export function isKnownLoopShape({ phase, message, stack }) {
  return CONNECTED_PHASES.has(phase) && message === KNOWN_LOOP_MESSAGE && KNOWN_LOOP_TOP_FRAME.test(topFrame(stack))
}

/** errors: [{ phase, message, stack }] → { tolerated: { [phase]: n }, problems: string[] } */
export function classifyPageErrors(errors) {
  const tolerated = {}
  const problems = []

  for (const error of errors) {
    if (isKnownLoopShape(error)) {
      tolerated[error.phase] = (tolerated[error.phase] ?? 0) + 1
    } else {
      problems.push(`[${error.phase}] pageerror: ${error.message}\n    ${topFrame(error.stack).trim() || '(no stack)'}`)
    }
  }

  for (const [phase, count] of Object.entries(tolerated)) {
    if (count > KNOWN_LOOP_LIMIT_PER_PHASE) {
      problems.push(
        `[${phase}] baseline render-loop pageerror ×${count} exceeds the bound of ${KNOWN_LOOP_LIMIT_PER_PHASE} ` +
          `(baseline ~${KNOWN_LOOP_BASELINE_PER_PHASE})`
      )
    }
  }

  return { tolerated, problems }
}
