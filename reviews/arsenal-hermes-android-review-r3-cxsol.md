# Hermes Android — R3 review, cxsol

Reviewed HEAD `728a5959797015cc8addcd54770598ecefab9231` on 2026-10-23 against `run/briefs/review-r3.md`, `git show 728a595`, both R2 reports, and the resulting code. No application source changed and nothing was pushed. This report is the only repository file added by this review; harnesses, transforms, logs and screenshots are under `/tmp`.

The saved-row diagnostic and lifecycle regression coverage are fixed. All required gates pass. The smoke classifier now enforces phases and counts, but its new stack rule still accepts unrelated errors anywhere in a large shared bundle. A production-browser injection reproduced a false pass without forging a stack. One P2 finding remains.

## Finding

### CXSOL-R3-1 — [P2] Match the guard's location, rather than its entire shared chunk

**Location:** `app/scripts/smoke-classifier.mjs:22`, used at lines 39–40. Related claims: classifier comments at lines 14–16 and `app/README.md:324–330`.

`KNOWN_LOOP_TOP_FRAME` accepts every function and every line/column in any `capabilities-*.js` asset. It does not identify tap's guard or even require a call through that hook. The actual `capabilities-B1fqOH3C.js` is approximately 534 KB of shared code. The baseline's first frame is at `4:1991`; an unrelated callback at `32:127` receives the same allowance.

**Executed reproduction:** `/tmp/hermes-cxsol-r3-run-smoke.mjs` wraps Playwright's context creation, then imports the unchanged production `scripts/smoke.mjs`. For the `chunk` case, a response route fetches the real built capabilities bundle and appends one timer callback, gated on an already saved gateway:

```js
setTimeout(function unrelatedAndroidRegression() {
  throw new Error('Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.')
}, 1000)
```

The bundle and repository files on disk are unchanged. There is no `sourceURL`, assigned `Error.stack`, or synthetic pageerror event. Chromium reports this genuine uncaught throw in each connected document as:

```text
Error: Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.
    at unrelatedAndroidRegression (http://127.0.0.1:4289/assets/capabilities-B1fqOH3C.js:32:127)
```

Both injected failures were swallowed. The actual smoke completed its surface, font, preview-unavailable and phone-drawer checks, then exited **0**:

```text
[tablet] baseline-shaped render-loop pageerror ×8 (tolerated, bound 21): tap getSnapshot guard message, top frame in the capabilities-* chunk
[phone] baseline-shaped render-loop pageerror ×8 (tolerated, bound 21): tap getSnapshot guard message, top frame in the capabilities-* chunk
SMOKE OK: onboarding → connected chat surface (tablet + phone), page errors limited to the bounded baseline render-loop shape, zero bridge errors
```

Independent capture recorded 16 errors, including the two `unrelatedAndroidRegression` errors. This is an injected regression demonstrating the acceptance gate's weakness, not a claim that another natural loop was discovered.

Controls demonstrate that the new checks do work within their stated scope:

- An ordinary same-message throw from `<anonymous>:4:15` fails, including during onboarding: exit **1**.
- The same bundle callback with message `unrelated regression` fails: exit **1**, with its `32:127` frame printed.
- Injecting 22 same-message bundle callbacks per connected document fails: exit **1**, with 29 errors per phase exceeding 21.
- The unmodified production smoke passes: exit **0**, with six tablet and eight phone baseline errors.

The documented caveat about another resource looping **through the same generic hook** is reasonable, but does not describe this broader failure. The README explicitly says the accepted frame is “inside tap's hook” and errors “from any other origin” fail. Neither is enforced. The unrelated-stack unit test only uses an anonymous frame, so it misses unrelated code packaged into the accepted asset.

**Required correction:** identify the actual guard throw site/call path in the current build, retaining phase and count limits, and add a negative check for a different function/location in the same capabilities bundle. A build-derived guard location or source-mapped origin can distinguish this demonstrated case; fail closed if it cannot be identified. Keep the separate limitation about other resources using that same hook explicit. Merely documenting that the whole bundle is allowed would leave the requested unrelated-error gate incomplete.

## R2 fix-forward verification

| Requested fix | Result |
| --- | --- |
| CXSOL-1: registry Test targets saved row | **Fixed.** `connections.test` reads `loadGateway()` and passes that snapshot to `testGateway`; operational transports retain `requireGateway()`. The new regression boots A, saves B, verifies B's status/sessions URLs, B's REST token and B's WebSocket URL/token, then verifies ordinary REST still uses A. The no-saved-gateway branch returns a failed result. |
| BOTH-2: message-only, unbounded, all-phase exception | **Partially fixed.** Exact message plus top-frame chunk, connected phases only, and independent per-phase bounds are implemented and tested. Live negative controls confirm enforcement. The chunk-wide origin exception still produces the false pass above. |
| BOTH-3: lifecycle test never asserts WS/reload | **Fixed.** The test records B's WebSocket URL/token, observes no immediate reload, advances fake timers by 400 ms and asserts one reload. A failed WS probe on both registry save and settings apply preserves the old configuration and schedules no reload. |
| ASTRA: README overstatements | **Largely fixed.** Save-only versus apply behavior is now explicit; root README qualifies native capability differences, direct Electron webview usage, and absent device verification. The classifier's claim to identify a frame inside tap's hook remains too strong, as detailed above. |

I independently repeated the three lifecycle/targeting mutations using a temporary Vite transform; source files remained unchanged:

| Mutation | Platform test result |
| --- | --- |
| Remove `await probeWebSocket(...)` | **Caught:** 3 failed, 15 passed |
| Remove the scheduled reload | **Caught:** 1 failed, 17 passed |
| Change saved-row resolution back to `requireGateway()` | **Caught:** 1 failed, 17 passed |

These failures are assertion failures on the intended behavior, rather than load errors. R2's demonstrated lifecycle test weakness is closed.

## Gates and fresh-eyes pass

| Check executed | Result |
| --- | --- |
| `cd app && npm run typecheck` | **PASS**, exit 0 |
| `cd app && npx vitest run src/platform` | **PASS**, 18/18, exit 0 |
| `cd app && node --test scripts/smoke-classifier.test.mjs` | **PASS**, 6/6, exit 0 |
| `cd app && npm run build` | **PASS**, exit 0; existing config-loader/deprecated chunk-option warnings |
| Additional classifier boundary assertions | **PASS:** 21 errors independently allowed in each connected phase; 22 rejected; onboarding, unknown phase, absent stack and unrelated chunk rejected |
| Production browser smoke and injected controls | Results above; same-chunk unrelated throw produces a **false PASS** |

The fresh pass traced saved configuration → registry display/Test, booted configuration → REST/WS, apply → validation/persistence/reload, and smoke event collection → navigation-phase transition → final classification. The new reload seam delegates to the original `window.location.reload()` behavior. I found no additional runtime regression introduced by R6 in those paths. Renderer provenance remains intact: `diff -rq upstream/apps/desktop/src app/src` differs only by `platform`, and shared source matches upstream.

The smoke still verifies onboarding, connected surfaces at 1280/820/390px, the loaded wordmark font, explicit webview failure, phone drawer opening/dismissal and horizontal overflow. It does not establish Android device behavior or complete application functionality. Full Vitest, upstream Electron comparison and native/device checks were not rerun, as allowed by the brief.

Browser runs used Chromium 155, preview port 4289 and a review-owned `hermes serve --port 19849 --skip-build`, reusing the previous review's throwaway `/tmp/hermes-cxsol-r2-home` with a new synthetic token. No model turn or messaging gateway was started. The first preview attempts encountered a transient missing `dist/index.html` while concurrent builds were replacing generated output; completed runs above used the finished build. Review-owned preview and serve processes were stopped afterwards.

Evidence: `/tmp/hermes-cxsol-r3-build.log`; `/tmp/hermes-cxsol-r3-mutation.config.mjs` and `-mutation-{ws,reload,saved}.log`; `/tmp/hermes-cxsol-r3-run-smoke.mjs`; `/tmp/hermes-cxsol-r3-smoke-{baseline,chunk,anonymous,overflow,other-message}.log`; corresponding `/tmp/hermes-cxsol-r3-errors-*.json` and screenshot directories. These are local transient artifacts.

## Verdict: REJECTED
