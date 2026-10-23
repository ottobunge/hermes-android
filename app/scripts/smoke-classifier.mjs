// Page-error classifier for scripts/smoke.mjs (unit-tested in
// smoke-classifier.test.mjs).
//
// Exactly one failure class is tolerated: upstream's assistant-ui thread-list
// render loop, reproduced in the unmodified upstream Electron app (README
// "Upstream comparison"). It throws from @assistant-ui/tap's
// useSyncExternalStore 50-commit guard. A page error counts as that baseline
// only if ALL of:
//   1. its message is exactly the guard's message;
//   2. its TOP stack frame is the guard's own `Error(...)` construction site —
//      the file:line:col found in THIS build by findGuardSite(). No site found
//      (zero or several candidates) means no allowance at all: fail closed.
//      A served guard frame whose filename or coordinates differ from the
//      scanned site is rejected;
//   3. it happens in a connected-surface phase (onboarding gets no allowance —
//      the thread list isn't mounted there);
//   4. the phase's count stays within KNOWN_LOOP_LIMIT_PER_PHASE.
// Anything else is a problem.
//
// What this does NOT establish: the guard site is tap's generic hook, shared
// by every tap resource that uses useSyncExternalStore. A different resource
// looping through that same guard, within the bound, would still pass. It
// does reject the same message thrown from anywhere else, including other
// code in the same chunk.

export const KNOWN_LOOP_MESSAGE =
  'Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.'

// Observed per phase (page load + 20–100 s): 6–7 in this smoke, 8–9 in a
// reviewer's run, 5 in upstream Electron. The bound is 3x the typical 7.
export const KNOWN_LOOP_BASELINE_PER_PHASE = 7
export const KNOWN_LOOP_LIMIT_PER_PHASE = 3 * KNOWN_LOOP_BASELINE_PER_PHASE

const CONNECTED_PHASES = new Set(['tablet', 'phone'])

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The guard's throw expression as a minifier emits it: `Error(<msg>)` or
// `new Error(<msg>)`, any quote style. V8 reports the frame at the start of
// that expression (`new` when present, else `Error`).
const GUARD_EXPRESSION = new RegExp(
  `(?:new\\s+)?Error\\((["'\`])${escapeRegExp(KNOWN_LOOP_MESSAGE)}\\1\\)`,
  'g'
)

/**
 * assets: [{ name, source }] (the built JS files) → { file, line, column } of
 * the single guard throw site, or null when there isn't exactly one.
 */
export function findGuardSite(assets) {
  const sites = []

  for (const { name, source } of assets) {
    const lines = source.split('\n')

    lines.forEach((text, index) => {
      for (const match of text.matchAll(GUARD_EXPRESSION)) {
        sites.push({ file: name, line: index + 1, column: match.index + 1 })
      }
    })
  }

  return sites.length === 1 ? sites[0] : null
}

function topFrame(stack = '') {
  return (
    String(stack)
      .split('\n')
      .find(line => /^\s*at /.test(line)) ?? ''
  )
}

function isGuardFrame(frame, site) {
  if (!site) {
    return false
  }

  const location = `/assets/${escapeRegExp(site.file)}:${site.line}:${site.column}`

  // `at <url>` (anonymous, as observed) or `at <name> (<url>)`.
  return new RegExp(`^\\s*at (?:\\S+ \\()?\\S*${location}\\)?\\s*$`).test(frame)
}

export function isKnownLoopShape({ phase, message, stack }, site) {
  return CONNECTED_PHASES.has(phase) && message === KNOWN_LOOP_MESSAGE && isGuardFrame(topFrame(stack), site)
}

/**
 * errors: [{ phase, message, stack }], site: findGuardSite() result →
 * { tolerated: { [phase]: n }, problems: string[] }
 */
export function classifyPageErrors(errors, site) {
  const tolerated = {}
  const problems = []

  for (const error of errors) {
    if (isKnownLoopShape(error, site)) {
      tolerated[error.phase] = (tolerated[error.phase] ?? 0) + 1
    } else {
      const why = site ? '' : ' [no guard site identified in this build: no allowance]'
      problems.push(`[${error.phase}] pageerror: ${error.message}${why}\n    ${topFrame(error.stack).trim() || '(no stack)'}`)
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
