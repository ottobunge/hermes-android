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
