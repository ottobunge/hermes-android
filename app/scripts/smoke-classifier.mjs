// Page-error classifier for scripts/smoke.mjs (unit-tested in
// smoke-classifier.test.mjs).
//
// No page error is tolerated. The assistant-ui thread-list render loop that
// earlier rounds tolerated ("Maximum update depth exceeded …") is fixed by
// patches/@assistant-ui+core+0.2.23.patch, so any "Maximum update depth
// exceeded" error is now reported as a render-loop regression, in every phase
// and from any location.

const RENDER_LOOP = /^Maximum update depth exceeded\b/

function topFrame(stack = '') {
  return (
    String(stack)
      .split('\n')
      .find(line => /^\s*at /.test(line)) ?? ''
  )
}

/** errors: [{ phase, message, stack }] → { problems: string[] } — one per error. */
export function classifyPageErrors(errors) {
  const problems = errors.map(({ phase, message, stack }) => {
    const kind = RENDER_LOOP.test(message)
      ? 'render-loop regression (patches/@assistant-ui+core+0.2.23.patch)'
      : 'pageerror'

    return `[${phase}] ${kind}: ${message}\n    ${topFrame(stack).trim() || '(no stack)'}`
  })

  return { problems }
}

// console.error lines that mean the UI broke even though nothing reached
// window.onerror: React error boundaries CATCH render errors (so no
// pageerror) and report them via console.error("[error-boundary:<label>]", …)
// (src/components/error-boundary.tsx), and React logs the caught error itself.
// A boundary may auto-recover, so the DOM alone can miss it. Unrelated
// diagnostics — e.g. "Failed to load resource … 409" — are not problems.
const BOUNDARY_REPORT = /^\[error-boundary(?::[^\]]*)?\]/

/** text of a console.error message → problem description, or null. */
export function classifyConsoleError(text) {
  const message = String(text)
  const firstLine = message.split('\n')[0].slice(0, 240)

  if (BOUNDARY_REPORT.test(message)) {
    return `error boundary caught a render error: ${firstLine}`
  }

  if (/Maximum update depth exceeded/.test(message)) {
    return `render-loop regression (patches/@assistant-ui+core+0.2.23.patch), caught and logged: ${firstLine}`
  }

  return null
}
