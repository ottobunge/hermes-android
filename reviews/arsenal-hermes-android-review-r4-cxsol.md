# Hermes Android — R4 closure review, cxsol

Reviewed HEAD `533a2d49f443971a63d1e67e117b250f58468545` on 2026-10-23 against `run/briefs/review-r4.md`, the complete commit diff, both R3 reports, and the resulting scripts. Application source and configuration were not edited. This report is the only repository file added by this review; probe scripts, build output, logs and screenshots are under `/tmp`. Nothing was pushed.

**The R3 blocker is closed.** The original production-browser injection now fails, while the unmodified production smoke passes. Guard discovery, exact coordinates, missing/ambiguous candidates, changed hashes, phases and count limits passed independent checks. One nonblocking documentation precision nit remains.

## R3 closure: real browser injection

Reused `/tmp/hermes-cxsol-r3-run-smoke.mjs` as the basis for `/tmp/hermes-cxsol-r4-run-smoke.mjs`, changing only review artifact paths, preview port and the new `--dist` argument. It wraps Playwright and imports the unchanged production smoke script. The `chunk` mode intercepts the actual capabilities response and appends the same connected-only timer callback used in R3:

```js
setTimeout(function unrelatedAndroidRegression() {
  throw new Error('Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.')
}, 1000)
```

Repository assets on disk were unchanged. There was no `sourceURL`, stack assignment or synthetic pageerror event. Chromium 155 supplied the stack. The scanner independently identified the real guard as `capabilities-B1fqOH3C.js:4:1991`; the appended callback remained at `32:127`.

The full injected smoke completed its UI checks, tolerated seven actual guard errors in each connected phase, rejected both injected errors and exited **1**:

```text
SMOKE FAILED:
[tablet] pageerror: Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.
    at unrelatedAndroidRegression (http://127.0.0.1:4291/assets/capabilities-B1fqOH3C.js:32:127)
[phone] pageerror: Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.
    at unrelatedAndroidRegression (http://127.0.0.1:4291/assets/capabilities-B1fqOH3C.js:32:127)
```

The unmodified smoke exited **0**, with seven tolerated guard errors per phase. It exercised onboarding, Save and reconnect, connected surfaces at 1280/820/390px, font loading, explicit webview unavailability, phone drawer opening/dismissal and overflow. A third full run with `--dist` pointing to an empty directory exited **1**, rejecting all 12 observed baseline errors with `no guard site identified in this build: no allowance`.

## Guard discovery and boundary checks

Independent assertions in `/tmp/hermes-cxsol-r4-boundaries.mjs` passed:

| Case | Result |
| --- | --- |
| Scan the fresh production assets | Exactly one site, `capabilities-B1fqOH3C.js:4:1991`; surrounding minified code is the `++o.current > 50` guard, followed by resetting the counter and constructing the error |
| `Error(...)` and `new Error(...)`, each with single, double and backtick quotes | All six discovered coordinates agree with actual V8 stacks from executing the expressions; `new Error` records `new` |
| Remove the guard chunk, or supply no assets | `null`; a guard-shaped pageerror is rejected |
| Two candidates in one file or across files | `null`; no allowance |
| Change punctuation in the guard message | No candidate |
| Rename the scanned guard asset to a new hash | Discovery follows the new filename; a new-name stack fails against the old site and passes against the newly derived site |
| Wrong file, extension, line or column; a column with an extra trailing digit; missing stack | Rejected |
| Onboarding, unknown or absent phase | Rejected |
| 21 matching errors independently in tablet and phone | Both allowed |
| 22 matching errors in one phase | Rejected for exceeding the bound |

The committed 11 tests also cover a guard frame buried below another top frame, same-chunk unrelated locations, another error message and a missing site. The scanner is a conservative expression locator for the trusted local build, rather than a JavaScript parser; unsupported formatting can deny the exception. No false acceptance was found in the requested guard-discovery scenarios.

## Nonblocking finding

### CXSOL-R4-1 — [P3] Qualify the claim about a different served build

**Location:** `app/README.md:317`; repeated in `app/scripts/smoke-classifier.mjs:12` and `app/scripts/smoke.mjs:37`.

The README says a different build being served means no allowance. The implementation compares only the guard asset's filename, line and column against locally scanned `--dist` assets. It does not authenticate the served build as a whole. A different build can retain that exact guard asset while changing another asset; errors at the unchanged guard site remain tolerated.

An independent in-memory check changed a non-guard asset's source, left the guard asset unchanged, and confirmed that discovery returned the identical site and a matching pageerror remained allowed. Evidence: `/tmp/hermes-cxsol-r4-build-identity.log`. This is a documentation scope issue, not a remaining instance of the R3 unrelated-location false pass.

Suggested wording: “A served guard asset with a different filename or guard location will not match the scanned build's site.” The README's central claims about exact location, phases, counts, fail-closed discovery and the remaining shared-resource limitation otherwise match the check.

## Gates and fresh-eyes pass

| Check executed | Result |
| --- | --- |
| `cd app && npm run typecheck` | **PASS**, exit 0 |
| `cd app && npm run build` | Initial attempt failed with `ENOTEMPTY` removing `dist/assets` while another build was writing the shared output directory |
| `cd app && npm run build -- --outDir /tmp/hermes-cxsol-r4-dist` | **PASS**, exit 0, 17,823 modules; 1m 27s. Same production configuration with an isolated output destination |
| `cd app && npx vitest run src/platform` | **PASS**, 18/18, exit 0 |
| `cd app && node --test scripts/smoke-classifier.test.mjs` | **PASS**, 11/11, exit 0 |
| Additional guard/boundary assertions | **PASS**, cases above |
| Full unmodified browser smoke | **PASS**, exit 0 |
| R3 same-chunk unrelated-function injection | Expected **FAIL**, exit 1, both injected errors rejected |
| Full browser smoke with missing guard assets | Expected **FAIL**, exit 1, all observed pageerrors rejected |
| `git diff --check` | **PASS** |

The diff is limited to the classifier, its tests, smoke integration and README. Guard discovery occurs before browser launch and reads every top-level built `.js` asset; the result is passed into final classification. The frame expression anchors the complete filename and numeric location. Each pageerror is still recorded once; desktop attribution changes on the main-frame navigation after Save and reconnect, phone has its own label, and the per-phase bound remains 21. No additional blocking regression was found in the changed paths.

The retained limitation is explicit and accurate: another tap resource looping through the same generic guard within the bound can pass. This review does not establish which resource looped, complete application functionality or Android/device behavior. Full Vitest, upstream Electron and native/device checks were not rerun, as permitted by the brief. Existing Vite config-loader and deprecated chunk-option warnings remain.

Browser runs used the isolated production build on preview port 4291 and a review-owned `hermes serve --port 19849 --skip-build`, reusing the previous review's throwaway `/tmp/hermes-cxsol-r2-home` and synthetic token. No model turn or messaging gateway was started. Review-owned server and preview processes were stopped afterwards.

Evidence: `/tmp/hermes-cxsol-r4-build.log` (initial output race), `-build-isolated.log`, `-platform.log`, `-classifier.log`, `-boundaries.mjs`, `-boundaries.log`, `-build-identity.log`, `-run-smoke.mjs`, and `-smoke-{baseline,chunk,missing}.log`, plus corresponding screenshot directories. These are transient local artifacts.

## Verdict: APPROVED_WITH_NITS
