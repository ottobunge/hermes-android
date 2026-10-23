# Hermes Android — R3 fix-forward review (astra)

Reviewed `728a5959797015cc8addcd54770598ecefab9231`, `git show 728a595`, the resulting implementation, and both R2 reports against `run/briefs/review-r3.md`. Application source was not changed. All requested gates pass, and the connection/lifecycle fixes are effective. The smoke classifier still has a demonstrated false-negative path.

## Finding

### R3-1 — P2: A chunk-wide stack match still accepts unrelated exceptions

**Location:** `app/scripts/smoke-classifier.mjs:22,39–40`; related claims at `app/README.md:322–328` and classifier comments at lines 14–17.

`KNOWN_LOOP_TOP_FRAME` accepts every function and every line/column in every `capabilities-*.js` file. It does not identify tap's hook or the reproduced thread-list call path. The actual main capabilities chunk is 534,031 bytes and contains much more than that hook. An unrelated throw with the matching message anywhere in that chunk is tolerated during tablet/phone phases until the shared count exceeds 21.

**Executed browser reproduction:** served the actual production `dist/` through a temporary loopback HTTP server and appended this mutation to the capabilities chunk's response, leaving the files on disk unchanged:

```js
setTimeout(function unrelatedAndroidRegression() {
  throw new Error('Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.')
}, 100)
```

Chromium 155 loaded the real module and its dependencies. Playwright captured an actual uncaught `pageerror`, with this browser-generated first frame:

```text
at unrelatedAndroidRegression (http://127.0.0.1:<port>/assets/capabilities-B1fqOH3C.js:32:56)
```

Passing that captured message/stack to the unchanged classifier with `phase: 'tablet'` returned:

```json
{"tolerated":{"tablet":1},"problems":[]}
```

No stack replacement, `sourceURL` spoofing, or fabricated capabilities filename was used. This function does not execute tap's hook at all. The probe was repeated after the fresh build. As controls, the same captured exception fails in onboarding, and 22 copies fail the count limit. The committed six classifier tests also pass; their unrelated-stack test uses `<anonymous>` and therefore misses an unrelated function sharing the accepted chunk.

This is an isolated classifier/browser mutation test, not a claim that the unmodified application currently throws this extra exception or that a full injected end-to-end smoke was run. It establishes that the final classifier can accept an unknown origin. The production smoke passes the same phase/message/stack fields to this function and only adds its `problems` to the verdict.

The README explicitly acknowledges new loops through the same generic hook, which is useful, but its narrower claim that tolerated stacks are “inside tap's hook” and that errors from any other origin fail is false. The demonstrated exception is outside that hook. A filename hash change also remains accepted as long as the `capabilities-` prefix survives; the regex is not a build identity check.

**Required change:** match the reproduced source/call path rather than a whole output chunk, and add a same-chunk unrelated-function negative test. Any build-specific fingerprint needs to fail closed when the relevant code changes. If the production evidence cannot distinguish the baseline, keep an explicit known-failure result instead of treating these unknown errors as a passing gate. Preserve the useful phase and count limits. Align the README/comments with what the resulting check actually establishes.

## R2 fix dispositions

| Requested fix | Result |
| --- | --- |
| CXSOL-1: registry Test probes active A instead of saved B | **Fixed.** `connections.test` loads the same saved configuration used by `registry()`, while operational REST still uses the booted cache. The new test boots A, saves B, checks B's status/sessions URLs, token header and WS URL, then checks REST remains on A. Reverting the diagnostic target to `requireGateway()` makes that test fail. The no-saved-gateway branch returns a structured unsuccessful result. |
| BOTH-2: generic, unlimited, all-phase smoke exception | **Partially fixed; still blocking.** Exact message, first-frame chunk filter, connected-phase restriction and a 21-per-phase limit are implemented and tested. Unknown origins in that same chunk remain accepted, as reproduced above. |
| BOTH-3: lifecycle test does not assert WS/reload | **Fixed.** The test asserts the new gateway's WS URL/token, persistence, no immediate reload, and one reload after advancing fake timers by 400 ms. Failed WS probes through both save and apply reject, preserve storage and do not reload. Independent mutations removing WS validation fail three tests; removing reload fails one. This proves the missing lifecycle steps are now protected. The test checks reload by 400 ms, not the exact lower timing boundary, which does not undermine this fix. |
| ASTRA: README summaries overstate behavior | **Requested summaries corrected.** The root README acknowledges direct Electron webview use, unavailable native features and absent device validation. The app README distinguishes apply/test/save/reload from save-for-next-restart and documents saved-row Test. The new classifier-origin claim still needs correction with R3-1. |

## Fresh-eyes pass

The production bridge diff is narrow: saved-row diagnostics and a reload indirection used by the test spy. `pageLifecycle.reload` still calls `window.location.reload()` normally; the timer remains 400 ms. Mock restoration is present after each test. The shared connection validation, credential isolation and booted transport cache remain intact. No additional production regression was found in those changed paths.

The smoke captures each page error once and classifies it at the end. Desktop attribution switches on the main-frame navigation after Save and reconnect; errors before that remain onboarding. Phone has a separate connected-phase label. Per-phase counting is bounded and independent. These are meaningful improvements, but do not cure the origin check.

Renderer parity remains intact: `diff -rq upstream/apps/desktop/src app/src` reports only `Only in app/src: platform`. The app remains explicit about absent Android/device verification and the untriaged full-suite failures. Those existing limitations are not new findings.

## Verification

| Check executed independently | Result |
| --- | --- |
| `cd app && npm run typecheck` | PASS, exit 0 |
| `cd app && npx vitest run src/platform` | PASS, 1 file / 18 tests |
| `cd app && node --test scripts/smoke-classifier.test.mjs` | PASS, 6 tests |
| `cd app && npm run build` | PASS, exit 0; Vite reported 1m 21s |
| Remove WS probe via temporary in-memory Vite transform | Expected FAIL, 3 failed / 15 passed |
| Remove scheduled reload via temporary in-memory Vite transform | Expected FAIL, 1 failed / 17 passed |
| Revert saved-row Test to booted gateway via temporary transform | Expected FAIL, 1 failed / 17 passed |
| Real built-module unrelated-function injection in Chromium | **False acceptance**, no classifier problems |
| Injected exception in onboarding / above phase limit | Correctly rejected |
| Renderer parity / `git diff --check` | PASS |

Build/test warnings remain about `advancedChunks` deprecation and future native config-loader compatibility. No full Vitest suite, full gateway/UI smoke, upstream Electron comparison, or Android build/device test was run in this review.

Transient evidence: `/tmp/hermes-astra-r3-probe.mjs`, `/tmp/hermes-astra-r3-probe.json`, `/tmp/hermes-astra-r3-build.log`, `/tmp/hermes-astra-r3-mutation.config.mjs`, and `/tmp/hermes-astra-r3-mutation-{ws,reload,target}.log`. The mutation config changes only modules supplied to the test runner. The browser/server were closed after the probe. The report is the only intended repository change.

## Verdict: REJECTED
