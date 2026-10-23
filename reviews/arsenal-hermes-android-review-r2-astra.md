# Hermes Android phase 1 — round 2 review (astra)

Reviewed HEAD `a634cffe197d176905ce82961d11a3648fcd9b36` against `run/briefs/review-r2.md`, the round-1 astra report, `git show a634cff`, and the resulting implementation and renderer consumers. No application code changed. The original runtime blockers are addressed, but the new smoke exception weakens the acceptance gate enough to require correction.

## Findings

### R2-1 — P2: The smoke whitelist suppresses unrelated render loops without a bound

**Location:** `app/scripts/smoke.mjs:36–50`.

The exact-message comparison is narrower than a substring filter, but the message is not specific to the reproduced thread-list defect. The installed `@assistant-ui/tap/src/react-hooks/useSyncExternalStore.ts:59` throws this same string from its generic external-store hook after more than 50 consecutive failed snapshot checks. A different store regression can therefore emit the identical message.

The handler ignores the stack, accepts the error in every phase (including onboarding), and has no count limit. The final verdict only checks `problems`; any number of these errors leaves that array empty. Consequently, the new smoke can turn green even when a new render loop occurs, provided the sidebar/composer and drawer checks still pass. Those checks do not establish that the affected store or chat actions work. The README's reported upstream reproduction justifies identifying that particular baseline defect, not waiving every occurrence of a library-wide diagnostic.

**Executed reproduction:** evaluated the actual constant and `watch` function extracted from `smoke.mjs` in an isolated Node VM, registered a fake page's event callbacks, and delivered 100 errors with the matching message and a deliberately unrelated `UnrelatedStore (new-port-code.ts:42:1)` stack during the `onboarding` phase. Result:

```json
{"problems":[],"tolerated":[["onboarding",100]]}
```

A different-message control correctly populated `problems`. This verifies the gate's false-negative behavior; it does not claim a second live render loop was found in the app.

**Required change:** keep uncaught errors fatal by default. If a baseline exception is retained, identify the reproduced source/call path and expected phase, impose an explicit bounded allowance, and fail unknown origins or excess occurrences. Add small classifier checks for unrelated stacks, unexpected phases and excess counts. If production stacks cannot reliably distinguish the baseline, retain a failing/known-failure result instead of treating the generic message as a passing gate.

### R2-2 — P3: The material-edit regression test never checks reload

**Location:** `app/src/platform/bridge.test.ts:145–158`.

The test named “test → save → reload” asserts only the HTTP URLs and persisted configuration. Removing `setTimeout(() => window.location.reload(), 400)` from `applyAndReload` would leave those assertions satisfied. The separate REST-pinning test would also continue to pass: it deliberately expects the old server after a save. This leaves the last, essential step of the lifecycle fix unprotected.

The production implementation does schedule reload correctly; this is a coverage nit, not an observed switching failure. Assert the reload after advancing the timer, and preferably verify a failed connection test neither saves nor reloads. The existing fake WebSocket also does not record the URL/token, so the test name should not be taken as proof of the entire connection lifecycle.

## Disposition of each requested fix

| Fix | Result and evidence |
|---|---|
| P1-1 credential isolation | **Fixed.** Both `coerce` and registry save call `resolveGatewayEdit`. Token inheritance requires equality of normalized endpoints, including scheme/path. Changing endpoints without an explicit token throws before persistence or connection testing. The regression covers both save APIs and unchanged storage. |
| P1-2 split connection | **Fixed in production code.** Material registry edits call `testAndReload`; label-only edits save in place. `requireGateway`, connection descriptors, WS URLs, REST and revalidation share the cached active gateway. Settings save persists for the next boot without moving active REST. Apply tests, saves and schedules reload. Reload coverage has the gap above. |
| P2-3 body timeout | **Fixed.** One timer surrounds fetch and body consumption; `readBody` races body completion against abort even for a stalled mock. The new stalled-body check passes. Body transport errors remain retryable only for GET/HEAD/OPTIONS; an isolated production-module POST probe returned the body-loss error after exactly one fetch. |
| P2-4 Android cleartext | **Resolved by reduced supported scope.** Capacitor no longer sets `allowMixedContent`. Config and app README explicitly support HTTPS/WSS and defer a native cleartext decision until the native project exists. Onboarding warns that HTTP exposes the token. This is honest about the absence of native HTTP verification. |
| CXSOL-4 font | **Fixed at build level.** The package-asset alias resolves the vendored relative font URL. My fresh build emitted `Collapse-Bold-mgICk9-_.woff2` (59.14 kB); generated CSS contains the Collapse 700 face referencing that file. Browser font loading was reported by the author, not independently rerun here. |
| ASTRA-4 previews | **Fixed for explicit unavailability.** `normalizePreviewTarget` returns null, and the fallback is installed before the renderer imports. Existing URL tabs that bypass classification receive `did-fail-load`; the actual `PreviewPane.onFail` accepts the supplied fields, clears loading and displays its error card with an `openExternal` link. `loadURL` rejects for subsequent navigation, matching the consumer's catch path. Blank tabs stop loading; remote HTML takes the separate iframe path. An isolated jsdom probe confirmed the emitted message/URL and navigation rejection. |
| ASTRA-5 tokenless apply | **Fixed.** Coercion rejects a missing usable token before any request; `testGateway` also refuses absent tokens. The corresponding no-request/no-persistence regression passes. |

## Fresh review and contract checks

- **Bridge contract:** the bridge remains explicitly typed as `Window['hermesDesktop']`; typecheck passes. No required bridge member was removed in this change. The round-1 contract inventory still applies except that preview normalization is now stubbed. The app README now describes profile subscriptions, registry no-ops, optional omissions, notification limitations and download dispatch accurately. Optional presence still does not prove native fidelity.
- **Transport/security:** endpoint edits no longer move credentials implicitly. Manual redirects, token-header authentication, scoped requests and the conservative mutation retry policy remain intact. The cached gateway prevents a stored edit from redirecting later REST while old sockets remain alive. Admitted localStorage/token-warning behavior remains unchanged; no new credential-disclosure path was established. No dependency audit or live security test was performed.
- **Preview integration:** the synthetic event is compatible with the renderer, not merely with its smoke listener. The fallback does not implement a browser; auxiliary preview tools remain unavailable. External opening on a real Android WebView is still unverified.
- **Phone gating:** CSS remains limited to `max-width:767.98px`, and drawer pointer handling checks the upstream below-640px media query. The delegated click handler and pointer-cancel reset remove the round-1 per-gesture listener accumulation. Same-URL selection and navigation delayed beyond the zero-delay check remain limitations; boundary widths, rotation, keyboard and device insets were not exercised here.
- **Source isolation:** `diff -rq upstream/apps/desktop/src app/src` still reports only `Only in app/src: platform`. No renderer source fork was introduced.

## README accuracy

The app README now makes the deferred native project, HTTP policy, localStorage, preview unavailability and failing full suite explicit. Its smoke output is labeled as tolerating the known message, so it does not claim zero pageerrors. However, calling every matching error “the known upstream one” overstates what the classifier establishes (R2-1).

Two minor prose issues remain: the opening lifecycle description says endpoint/token changes through either UI always test/save/reload, although Settings also exposes a save-only path, correctly described later in the bridge table. The root README still says the renderer never touches Electron directly and that everything served by the gateway works the same; the unchanged Electron `<webview>` consumer and documented unsupported preview surface contradict that broad framing. Align these summaries with the narrower app README. These prose issues are not additional blockers.

## Verification performed

| Check | Result |
|---|---|
| `cd app && npm run typecheck` | Pass, exit 0 |
| `cd app && npx vitest run src/platform` | Pass, 1 file / 16 tests |
| `cd app && npm run build` | Pass, exit 0; Vite reported 1m 16s |
| Fresh emitted font and CSS reference | Present |
| Renderer source parity | Only platform directory differs |
| Isolated actual smoke-handler probe | Reproduced R2-1; different-message control failed correctly |
| Isolated POST response-body failure probe | One fetch, no retry |
| Isolated preview fallback probe (jsdom) | Unavailable event and navigation rejection confirmed |
| `git diff --check` | Pass |

Build warnings include `advancedChunks` deprecation and future native-config-loader compatibility. An initial preview probe attempted an unavailable `happy-dom` package; it was rerun successfully with the installed jsdom. Probes transpiled/evaluated existing source in memory and used mock network/DOM objects, with no external requests or application source edits.

Not rerun: live gateway/browser smoke, Electron comparison, full renderer suite, APK/device validation. The upstream attribution remains the author's documented controlled comparison plus verified renderer parity, not a newly reproduced Electron diagnosis. Build output is ignored; the only intended review artifact is this report.

The application fixes satisfy the seven requested dispositions. Acceptance remains blocked by the new smoke false-negative policy in R2-1, rather than by a demonstrated remaining instance of the original runtime blockers.

## Verdict: REJECTED
