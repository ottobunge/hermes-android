# Hermes Android phase 1 — round 2 review, cxsol

Reviewed `a634cffe197d176905ce82961d11a3648fcd9b36` on 2026-10-23 against `run/briefs/review-r2.md`, including `git show a634cff`, the resulting source, and my round-1 report. No application source was modified and nothing was pushed. Review harnesses, mutation transforms, logs and screenshots were written under `/tmp`; this report is the only repository file I added.

The seven requested fixes are implemented, and typecheck, build, all 16 platform tests, and the production browser smoke pass. However, the active-gateway cache introduces a wrong-target registry connection test, and the smoke's new exception filter can suppress unrelated failures without limit. These are two P2 findings requiring correction. There is also a demonstrated gap in the new lifecycle regression test.

## Findings

### 1. [P2] Registry Test validates the active gateway instead of the saved row

**Location:** `app/src/platform/bridge.ts:433`, through the newly cached `requireGateway()` at lines 61–75.

Keeping operational REST calls and WebSocket descriptors on the booted gateway fixes the split-connection defect. But `connections.test` also calls `requireGateway()`, so it now tests that cached gateway even when the registry row describes a different saved endpoint or credential.

This is reachable through the existing UI:

1. Boot with gateway A.
2. In Settings → Gateway, enter B and its token, and choose **Save for next restart** (`gateway-settings.tsx:1727–1734`). The supported `saveConnectionConfig` path persists B while correctly keeping the running client on A.
3. Open Devices. `connections.list()` reads storage and displays B.
4. Test B's row. `connections.test('gateway')` probes A's status, sessions and WebSocket. `connections-registry.tsx:568–572` turns that successful result into a success notification titled with B's label.

**Reproduced:** with synthetic credentials and a fetch double that rejects every request to B, the saved/listed URL was `https://b.example`, but Test returned `{ok:true, baseUrl:'https://a.example'}`. Its only HTTP requests were:

```text
https://a.example/api/status
https://a.example/api/sessions?limit=1
```

The WebSocket probe also used A. No request reached B. The same mistake can falsely reject a newly saved valid token by testing the old active token instead.

This behavior is introduced by this commit: before the cache, the same `requireGateway()` call read the saved gateway. It does not reopen the REST/WS split; it makes a separate diagnostic operation report the wrong server's health.

**Minimum correction:** resolve the saved registry entry for `connections.test`, validate its token, and pass that snapshot to `testGateway`. Keep operational `api`, connection resolution and fresh WS URLs pinned to the active gateway. Add a check that boots A, saves B for the next restart, and proves the row's Test contacts B while normal REST still contacts A.

### 2. [P2] The smoke allowlist identifies a generic error message, not the verified upstream failure

**Location:** `app/scripts/smoke.mjs:36–50`; associated verification claim in `app/README.md:172–182` and its Smoke section.

Every page error with the exact `Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.` message is now tolerated. There is no restriction on source, resource, phase, frequency or total count. Exact equality avoids swallowing differently worded errors, but it does not identify the known thread-list defect: the installed `@assistant-ui/tap/src/react-hooks/useSyncExternalStore.ts:52–60` throws this same message from its generic hook, regardless of which resource caused the loop.

Consequently, a new store loop with the same guard message, an increased recurrence of the existing loop, or an unrelated throw with this text all remain green. Even onboarding, before the connected thread-list surface, receives the same unconditional allowance. Counting and printing the errors does not enforce a gate.

**Negative-check reproduction against the actual smoke script:** a temporary Playwright wrapper added 12 uncaught throws per document from a function named `unrelatedAndroidRegression`, using the tolerated text. The script itself and application source were unchanged. The baseline passed with six tolerated errors on tablet and six on phone. The injected run also exited **0**, with:

```text
[onboarding] known upstream pageerror ×12 (tolerated)
[tablet] known upstream pageerror ×18 (tolerated)
[phone] known upstream pageerror ×19 (tolerated)
SMOKE OK: onboarding → connected chat surface (tablet + phone), no pageerrors beyond the known upstream one, zero bridge errors
```

The independent error capture recorded 49 errors, including all **36** injected failures. Their stack began `at unrelatedAndroidRegression (<anonymous>:4:15)`, whereas baseline errors originated in the built `capabilities-*.js` chunk. These were deliberately injected failures demonstrating the filter's limits; I am not claiming to have discovered another naturally occurring render loop.

**Minimum correction:** retain failure for these errors until an enforced exception is available, or scope the exception to the verified failure and constrain when/how often it may occur. Add negative checks that unrelated same-message throws and excess occurrences fail. A stack check alone may still identify the shared hook rather than the responsible resource, so do not equate the message or generic hook frame with proven provenance.

The documented real-Electron reproduction remains credible evidence that the original loop is upstream. It does not establish that every future occurrence of this generic message is that same defect. The README accurately describes its message-only implementation, but “the known upstream one” overstates what the passing smoke establishes.

### 3. [P3] The lifecycle regression test passes without WebSocket validation or reload

**Location:** `app/src/platform/bridge.test.ts:145–158`.

The test named “routes a material registry edit through test → save → reload” asserts the two HTTP URLs and persisted configuration. It never checks that a WebSocket was constructed/opened or that a reload was scheduled/executed. The `OpenSocket` double provides no asserted evidence of its use.

**Mutation check:** using a temporary Vite transform, I removed both `await probeWebSocket(buildGatewayWsUrl(baseUrl, gateway.token))` and `setTimeout(() => window.location.reload(), 400)` from the module presented to Vitest. The repository files remained unchanged. **All 16 tests still passed.** Thus this gate permits removal of two essential parts of its stated lifecycle.

The actual implementation does perform those steps: an independent harness observed the B WebSocket probe and one reload after the 400 ms delay. This finding concerns regression coverage, not a missing reload in current source.

**Minimum correction:** assert the probe target and reload, and verify that a failed probe prevents persistence/reload. Use a controlled clock/window double so the check observes the lifecycle it names.

## Verification of the seven requested fixes

| Fix | Result against the resulting code |
| --- | --- |
| P1-1, credential inheritance | **Fixed.** Both config coercion and registry save call `resolveGatewayEdit`. Only equal normalized endpoints inherit a saved token. Independent checks rejected omitted, empty and whitespace tokens for changed endpoints on registry save, config save and apply, with no requests and unchanged storage. Same-endpoint label edits preserve the token. |
| P1-2, REST/WS split | **Fixed for operational transports.** `api`, `connect`, WS URL lookup and revalidation use the same cached gateway. Material registry edits call `testAndReload`; label edits save without requests. Independently observed B validation/save/reload while intervening REST and fresh WS lookup remained on A, including A's credential. Failed validation preserved A. Finding 1 is a new misuse of that cache in a diagnostic operation. |
| P2-3, stalled response body | **Fixed.** The attempt's timer survives through body consumption. A stalled POST body rejected with `Timed out reading…`, its signal was aborted, and there was one attempt. A dropped GET body retried; a dropped POST body did not. HTTP status/JSON/HTML handling remains outside the transient-body-failure retry path. |
| P2-4, Android cleartext claims | **Acceptably narrowed and deferred.** `allowMixedContent` is removed. Config and README identify HTTPS/WSS as supported and explicitly defer native HTTP policy until `android/` exists. The onboarding warning explains that HTTP exposes the token. There is no longer a claim that mixed-content permission alone enables Android HTTP. Browser HTTP smoke remains separate from native verification. |
| CXSOL-4, wordmark font | **Fixed.** The Vite alias resolves the vendored monorepo-relative package asset. This build emitted `Collapse-Bold-mgICk9-_.woff2`; the global styles reference it. Production preview returned `200 font/woff2`, 59,144 bytes, and the smoke's `document.fonts.load('700 32px Collapse')` check passed. The former unresolved-font warning is gone. |
| ASTRA-4, URL previews | **Fixed within the declared unavailable scope.** `normalizePreviewTarget` returns null. Entry installs the fallback before renderer import. The shim's deferred `did-fail-load` reaches the pane's existing error handler, and `loadURL` rejects into its navigation error path. The load-error URL link calls `openExternal`; retries fail explicitly. Blank Browser tabs are left blank, and sandboxed remote-HTML iframe rendering is untouched. The smoke verified the synthetic tag's unavailable event; I did not run a native external-browser integration test. |
| ASTRA-5, apply without token | **Fixed.** Edit resolution requires a usable token before any request or persistence; `testGateway` independently refuses missing tokens. `testConnectionConfig` returns a structured failed result for edit-resolution errors. |

The new stalled-body check would fail against the old implementation, and the active-gateway REST assertion exercises the previously broken storage reread. The lifecycle test's remaining weakness is specifically demonstrated in finding 3.

## Fresh coverage, security and phone checks

**Bridge contract:** repeated an AST inventory against `app/src/global.d.ts` and the bridge object: **148 top-level members, 277 declarations including nested containers, 136 present, 141 absent, zero missing required declarations**. There are no contract additions/removals relative to round 1. The prior complete inventory still describes presence; `normalizePreviewTarget` now belongs among unavailable stubs, while `getVersion` is reasonably documented as a web equivalent. The README now includes the previously omitted no-op subscriptions, optional connection/F12 members, `setPrimary` limitation, correct session-token header and 80-line returned log limit. It qualifies browser capabilities and single-gateway fidelity. Finding 1 limits the advertised registry Test behavior.

**Renderer provenance/startup:** `diff -rq upstream/apps/desktop/src app/src` again differed only by `src/platform`; shared source also matched. Bridge installation still precedes the dynamic renderer import. Font resolution is handled in build configuration, preserving the renderer copy. The new preview fallback patches element creation globally, but changes returned behavior only for `webview` tags, and the ordinary entry installs it once.

**Transport/security:** URL normalization, path-prefix-preserving WS derivation, token encoding and explicit profile scoping remain intact. The copied JSON-RPC WebSocket client remains unchanged; the REST adapter does not replace it. The response-body change retains conservative no-ambiguous-mutation retries. No additional cross-host credential disclosure was found in the edited paths. LocalStorage/`secureTokenStorage:true`, memory-only attachments and native permission gaps remain the admitted phase-1 limitations. Third-party social embed scripts still execute in the parent origin with access to storage/bridge, as described in round 1; artifact iframe isolation does not remove that separate trust grant. I did not establish a new script-injection exploit.

**Phone:** presentation CSS remains inside `max-width:767.98px`; drawer pointer handling requires the upstream `max-width:639.98px` condition and an overlay. Tablet layout is therefore untouched by the phone rules, while 640–767px rails remain docked as documented. The delegated click handler and `pointercancel` reset remove the per-gesture one-shot listener accumulation noted in round 1. Production smoke passed drawer opening, outside-tap dismissal and horizontal-overflow checks. I inspected the 820px and open-drawer 390px screenshots; the tablet screenshot still shows the scratch gateway's provider-setup overlay, which is documented. DOM assertions/screenshots do not establish complete visual or interaction parity. Rotation during navigation, keyboard/back behavior, right-rail interactions and Android lifecycle remain unverified.

**README/native readiness:** build, font, test-count and browser-smoke claims reproduce, subject to findings 2–3 about the strength of those gates. The README continues to disclose the untriaged full-suite failures and absent Android project/toolchain/APK. I did not count these admitted gaps as findings. HTTPS/WSS CORS/Origin behavior from the eventual Capacitor origin, native permissions, downloads/notifications, back/IME/insets, signing and storage policy still need device verification before an APK claim.

## Checks executed

| Check | Result |
| --- | --- |
| `cd app && npm run typecheck` | PASS, exit 0 |
| `cd app && npx vitest run src/platform` | PASS, 1 file, 16/16 tests |
| `cd app && npm run build` | PASS; native-config-loader/deprecated chunk-option warnings remain |
| Production preview font response and loaded-face check | PASS |
| Original production smoke at 1280, 820 and 390px | PASS, exit 0; six tolerated page errors on tablet and six on phone |
| Same smoke with unrelated same-message errors injected | **False PASS**, exit 0; 36 injected errors tolerated |
| Platform tests with WS validation and reload removed by temporary transform | **False PASS**, 16/16 |
| Independent credential/lifecycle/body-error harness | PASS for fixes; reproduced wrong-target registry Test |
| AST contract inventory and renderer/shared comparisons | PASS; counts above |
| Full suite / upstream Electron control / APK / Android device | Not rerun / not rerun / not built / not tested |

Browser runs used Chromium 155, Vite preview on port 4284 and a review-owned `hermes serve --port 19839 --skip-build` with a new `/tmp/hermes-cxsol-r2-home`. I initialized an empty scratch `state.db` directly; I did not start another host-wide messaging gateway or submit a model turn. This differs from the README's gateway-runtime setup and is adequate for these browser/transport checks, not a hermetic upstream-runtime comparison. The injected run also logged a 409 resource response, which the smoke logs without classifying as a page error. Review-owned preview and serve processes were stopped afterwards.

Evidence: `/tmp/hermes-cxsol-r2-harness.mjs`, `/tmp/hermes-cxsol-r2-mutation.config.mjs`, `/tmp/hermes-cxsol-r2-run-smoke.mjs`, `/tmp/hermes-cxsol-r2-smoke.log`, `/tmp/hermes-cxsol-r2-smoke-injected.log`, `/tmp/hermes-cxsol-r2-errors*.json`, `/tmp/hermes-cxsol-r2-contract.json`, and screenshot directories `/tmp/hermes-cxsol-r2-smoke*`. These are local transient review artifacts.

## Verdict: REJECTED
