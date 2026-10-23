# Hermes Android — R4 guard-site closure review (astra)

Reviewed `533a2d49f443971a63d1e67e117b250f58468545`, its four-file diff, the resulting smoke/classifier implementation, and the R3 astra reproduction against `run/briefs/review-r4.md`. The R3 blocking finding is **closed**. No new blocking correctness issue was found. Application source and tracked files were not changed; this report is the only review-authored repository addition.

## Finding

### R4-1 — P3: “a different build” overstates the identity check

**Locations:** `app/README.md:317–318`, `app/scripts/smoke.mjs:36–37`, and `app/scripts/smoke-classifier.mjs:10–12`.

The README says that serving a different build means no allowance and every page error fails. The implementation compares the guard chunk's filename, line and column; it does not compare the entire served build against `--dist`. A build that changes another asset while retaining the same guard chunk can still tolerate guard errors. This is appropriate for the origin check, but the absolute build-identity claim is inaccurate.

Independent control: adding an unrelated JS asset to the scanned build leaves `findGuardSite()` unchanged and the same baseline frame remains tolerated. Conversely, changing the guard chunk filename to `capabilities-NEW-HASH.js` rejects the old frame; rediscovering the renamed chunk and supplying its matching frame passes.

**Suggested wording:** “Zero or several candidates means no allowance. A served guard frame whose filename or coordinates differ from the scanned site is rejected.” Apply the same qualification to the comments. This is a documentation nit, not a remaining route for the R3 unrelated-function exception.

## R3 injection: now correctly rejected

Reused `/tmp/hermes-astra-r3-probe.mjs`, adapting it to pass the freshly discovered site into the new classifier and adding assertions. A loopback HTTP server served the real production modules, appending only this response-time mutation to the capabilities chunk:

```js
setTimeout(function unrelatedAndroidRegression() {
  throw new Error('Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.')
}, 100)
```

The browser generated the exception naturally; there was no replacement stack, `sourceURL` spoofing or fabricated chunk name. Chromium 155 captured:

```text
at unrelatedAndroidRegression (http://127.0.0.1:41271/assets/capabilities-B1fqOH3C.js:32:56)
```

The scanner found the actual minified tap guard at:

```text
capabilities-B1fqOH3C.js:4:1991
…if(++o.current>50)throw o.current=0,Error(`Maximum update depth exceeded.…`)
```

Classification of the captured exception with `phase: 'tablet'` returned **zero tolerated errors and one problem**. This is the same exception R3 falsely accepted. The scanner read the pristine build; the additional throw existed only in the HTTP response, so rejection did not depend on the duplicate-candidate safeguard. Separately, scanning a source containing both throws returned `null` as required.

This was a browser/module injection and classifier integration probe, not a full injected gateway/UI smoke run.

## Guard discovery and boundary checks

All independent assertions passed:

| Check | Result |
| --- | --- |
| Fresh minified production assets | Exactly one site, `capabilities-B1fqOH3C.js:4:1991`; surrounding code matches tap's 50-commit guard |
| `Error(...)` and `new Error(...)`, each with single, double and backtick quotes | Six real Chromium fixture exceptions matched the scanner's coordinates; `new Error` points at `new` |
| Two candidates in one chunk | `null`; no allowance |
| Two candidates across chunks | `null`; no allowance |
| Remove the guard chunk / empty asset list | `null`; baseline-shaped errors rejected with no site |
| Changed guard hash, stale frame | Rejected |
| Changed guard hash, rediscovered site and matching frame | Accepted within the connected-phase limit |
| Same chunk, other function/location | Real injected exception rejected |
| Exactly 21 / 22 matching errors | 21 accepted, 22 causes a problem, independently for tablet and phone |
| 21 tablet plus 21 phone | Accepted; counts remain independent |
| Onboarding and unrecognized phases | No allowance |

The committed tests additionally cover a guard frame buried below an unrelated top frame, off-by-one/prefix columns, other messages and unrelated stacks. All 11 pass.

Discovery is a textual scan of trusted generated assets, not semantic verification of arbitrary JavaScript. In this build the unique match is the actual tap guard. Duplicate matching text removes the allowance, and missing matches remove it as well. The README correctly retains the meaningful limitation: a different tap resource looping through that same generic guard within the bound can still pass. This review does not claim the classifier identifies the particular thread-list resource.

## Fresh-eyes pass and verification

The smoke scans JS assets before launching Chromium and passes the resulting site into the final classification. A missing assets directory produces an empty list. File-read errors abort rather than granting an allowance. The filename is regex-escaped and the frame match ends at the exact column, preventing partial column matches. Only the first stack frame is considered. The existing single listener per page, onboarding-to-tablet navigation transition, separate phone phase and per-phase count checks remain intact. No production bridge or renderer code changed in this round.

| Gate executed independently | Result |
| --- | --- |
| `cd app && npm run typecheck` | PASS, exit 0 |
| `cd app && npm run build` | PASS, exit 0; 1m 23s |
| `cd app && npx vitest run src/platform` | PASS, 1 file / 18 tests |
| `cd app && node --test scripts/smoke-classifier.test.mjs` | PASS, 11 tests |
| Isolated production rebuild and browser injection/control probe | PASS |
| `git diff --check` | PASS |

The shared `app/dist` changed during concurrent review activity: the successful build log listed capabilities chunks that were subsequently absent. Initial probes therefore stopped at the “site exists” assertion. To obtain stable evidence, I rebuilt with `npm run build -- --outDir /tmp/hermes-astra-r4-dist` and ran the successful browser probe against that isolated output. No classifier change was needed.

Vite emitted its existing config-loader/`advancedChunks` warnings and an isolated-build timing warning. No full Vitest suite, complete gateway/UI smoke, new upstream Electron comparison, Android build or device test was run. Historical README smoke results were inspected, not independently re-established by this closure review.

Transient evidence: `/tmp/hermes-astra-r4-{typecheck,build,build-isolated,platform,classifier}.log`, `/tmp/hermes-astra-r4-probe.mjs`, `/tmp/hermes-astra-r4-probe.json`, and `/tmp/hermes-astra-r4-dist`. The probe closed its browser and HTTP server.

## Verdict: APPROVED_WITH_NITS
