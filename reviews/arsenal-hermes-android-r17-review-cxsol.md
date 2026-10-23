## Verdict: REJECTED

Reviewed `git diff 7a7812b..5ad85ea` (`5ad85ea0f913e66df3faf0708458ad95f6bf4fb8`), the round-16 report, both original review probes, and the affected renderer and pinned Capacitor callers. Findings 1, 3 and 4 are closed. Finding 5 is only partly closed. The Android implementation also cannot compile from the reviewed commit: three required source/test files remain untracked. A conditional bridge-restoration regression needs correction.

Implementation files were left unchanged. Builds and temporary review tests ran in `/tmp/hermes-r17-cxsol-tree`, initially exported from the exact commit with `git archive`; dependencies were linked to the existing installation. The native checks explicitly distinguish that committed tree from a later, supplemented tree containing copies of the untracked Java files.

### Blocking findings

1. **[P1] The committed Android app does not compile because the new native classes were not committed.**

   Locations: `app/android/app/src/main/java/com/bunge/hermes/MainActivity.java:20` and `:75`.

   `MainActivity` now registers `HermesOauthPlugin` and calls `OauthCallback.match`, but neither class exists in `5ad85ea`. The claimed `OauthCallbackTest` is also absent. At review start, all three were present only as untracked working-tree files:

   ```text
   ?? app/android/app/src/main/java/com/bunge/hermes/HermesOauthPlugin.java
   ?? app/android/app/src/main/java/com/bunge/hermes/OauthCallback.java
   ?? app/android/app/src/test/java/com/bunge/
   ```

   **Reproduction:** export the committed `app/`, link its installed dependencies, supply the generated Cordova project, and run the native compile/unit-test tasks under `nix develop`. Compilation reaches the changed activity and fails:

   ```text
   > Task :app:compileDebugJavaWithJavac FAILED
   MainActivity.java:20: error: cannot find symbol
           registerPlugin(HermesOauthPlugin.class);
                          ^
   MainActivity.java:75: error: cannot find symbol
               OauthCallback callback = OauthCallback.match(...);
               ^
   3 errors
   BUILD FAILED
   ```

   `git ls-tree` and `git ls-files --error-unmatch` independently confirm the omissions. After copying just those untracked Java sources/test into the temporary export, the same compile and unit-test tasks pass, including both `OauthCallbackTest` methods. Thus the local build result documented in the README does not establish that the committed change builds. Include the required classes and tests in the reviewed revision.

2. **[P2] Wrong-state callbacks still cancel an active authorization; original finding 5 remains open.**

   Locations: `MainActivity.java:63–66,75–88`; `app/src/platform/oauth.ts:154–156,201–206,230–233`; supplemental, untracked `OauthCallback.java:47–49`.

   Native retains only `signingIn`, not the expected state. The supplied matcher checks redirect components and the presence of `code` and `state`; it cannot compare state with the authorization started by `begin()`. Consequently, while a legitimate sign-in with `state=expected` is active, this navigation still disarms sign-in and loads the app:

   ```text
   http://127.0.0.1/?code=attack&state=wrong
       → http://localhost/?oauth-code=attack&oauth-state=wrong
   ```

   **Reproduction:** a JVM source harness invokes the actual changed `GatewaySignInClient.begin()` and `shouldOverrideUrlLoading()` methods, with framework stubs and the supplied untracked matcher. The wrong-state URL produces that app load in modern, unsupported-feature, legacy, and listener-installation-failure configurations. This check does not emulate Android rendering or claim a device exploit.

   A separate executable Vitest check then exercises the real JavaScript completion function: the wrong-state callback returns `failed`, removes the genuine pending record, performs no fetch, and causes a subsequent correct callback to fail because no authorization remains. The existing state-mismatch test verifies token rejection but does not verify preservation of the active flow.

   The idle callback, unrelated path/port, missing-state, userinfo, fragment, and foreign-authorize attacks are now blocked from rewriting the app in the intended native flow. The original cancellation attack survives with the correct redirect shape and an incorrect state. This remains navigation cancellation, not demonstrated token injection: the JavaScript state check and PKCE prevent saving attacker credentials. Retain the expected state when native authorization begins and require equality before disarming, restoring interfaces, or reloading the app. Add an active-flow negative test that subsequently completes the genuine callback successfully.

3. **[P2, conditional] A supported WebView whose message-listener installation throws permanently loses its fallback bridge after sign-in or cancellation.**

   Locations: `MainActivity.java:115–135`; `app/src/platform/bridge.ts:316–323`; `app/README.md:178–182`. Relevant pinned dependency: `MessageHandler.java:26–41`.

   Capacitor falls back to a Java `androidBridge` both when the feature is unsupported and when `addWebMessageListener` throws on a supporting WebView. `detach()` removes it in both situations. `attach()` restores it only when the feature is unsupported or legacy mode is configured. In the exception case, there is neither a surviving modern listener nor a restored Java bridge.

   **Reproduction:** initialize the source harness with feature support enabled, legacy mode disabled, and the Java bridge installed as Capacitor's exception fallback. Run sign-in and return through the callback, or cancel through app-origin `onPageStarted` and its queued reload. The HTTP/cookie interfaces return; `androidBridge` does not. Unsupported-feature and explicit-legacy controls restore it correctly.

   This affects the newly introduced sign-in path. The README acknowledges losing plugins but incorrectly says the UI uses none: `pageLifecycle.beginSignIn` now depends on `HermesOauth.beginSignIn`. An independent check against the installed `@capacitor/core` confirms that removing `androidBridge`, with no replacement listener, changes `Capacitor.isNativePlatform()` from `true` to `false`. The next sign-in therefore selects ordinary navigation instead of native `beginSignIn`, never arming interception or interface detachment. Capacitor's default foreign-URL handling sends that navigation outside the intended in-app flow.

   This is a source-backed conditional functionality regression, not an observed frequency claim or a new demonstrated bridge exposure. Preserve the actual bridge choice across detachment, including listener-installation failure, and test a second sign-in after both callback completion and cancellation. An unconditional app-origin reload alone cannot recreate the Java bridge owned by the existing native activity.

### Original findings 1–5: attack replay and closure

| Round-16 finding | Attack against the new code | Result |
| --- | --- | --- |
| **1. Logout sockets and refresh resurrection** | Reran the original held-refresh probe. Its request now rejects with `401: Signed out`; no late token is installed. Reran the original browser logout/RPC probe: the page unload destroys its execution context instead of allowing the old probe to finish in the authenticated document. Independently ran the corrected live E2E against a real basic-auth gateway: both open authenticated sockets close, neither reopens with the old token, saved credentials are cleared, and the Gateway screen mounts. | **Closed.** The original browser probe exits nonzero because it assumes a surviving document; the independent socket check is the positive evidence of teardown. |
| **2. Foreign content calling native interfaces** | Traced the original `androidBridge.postMessage(...)` attack through the new `begin()` path. All three Java interfaces are removed before the authorize load. The source harness checks that the foreign document receives none in modern, unsupported-feature, legacy, and listener-throw configurations. The actual pinned `MessageHandler`, HTTP/cookie plugin registration, and default navigation code were inspected. | **Source-level mitigation is sound for that initial flow**, assuming the supplied missing classes are included. Not an Android/device verification and not complete approval of the committed native change; see findings 1 and 3 above. |
| **3. Shared refresh updates one object only** | Reran the original concurrent requests with two distinct gateway objects sharing a refresh token. Results change from `fulfilled/rejected` to `fulfilled/fulfilled`, with one refresh request. Checked the 401 outcome too: both caller objects and matching storage lose credentials. | **Closed.** The shared outcome is applied per still-current caller. |
| **4. Unbounded code exchange/refresh/body** | Reran both original minute-long stalls. Each now settles at the separate 30-second OAuth deadline and supplies an aborted signal. Additional checks stall response bodies, release a late success after timeout, and start a replacement refresh. | **Closed.** Both headers and body are bounded; timeout releases the shared refresh entry, and late replies cannot save credentials. The REST request's `timeoutMs` still does not bound the refresh leg, now accurately documented as a separate 30-second deadline. |
| **5. Unarmed/unrelated native callbacks** | Replayed idle callback and foreign-authorize navigation, plus bad port/path/userinfo/fragment and missing state. None rewrites the app in the supplemented source harness. Replayed a wrong-state callback during an active flow: it still reloads the app and consumes the real pending authorization. | **Partly closed; not closed overall.** See finding 2 above. The exact matcher and its JUnit test are also missing from the commit. |

The original `/tmp/hermes-r16-review-probe.test.ts` was run unchanged in the temporary export: **four bug-asserting reproductions failed, one expired-pending control passed**. Their failures occurred for the expected changed behavior, not import/build failures. Original probe files were preserved.

### Regression checks on the fixes

- **Reload on logout:** credential clearing precedes the scheduled reload. The existing settings sign-out caller can finish its immediate config update. A fresh entry sends the saved OAuth gateway without a token to onboarding. The live E2E observed zero page errors across unload and no socket reopening. A proactive WS refresh held across logout also cannot return an authenticated WS URL.
- **Interface removal/restoration:** the source harness covers initial detach, callback restoration, cancellation restoration, subframe callbacks, and a second app-origin `onPageStarted`; cancellation schedules one reload without a reload loop. Normal unsupported-feature and legacy restoration use the pinned `Bridge.msgHandler` field successfully at compile/source level. The listener-throw case fails restoration as described above. Actual WebView timing, Android Back behavior, and real foreign-page native calls were not device-tested. Android documents that Java-interface changes take effect on the next page load and that Java objects are exposed to every frame; the load ordering follows that contract. [Android WebView API](https://developer.android.com/reference/android/webkit/WebView#removeJavascriptInterface(java.lang.String)).
- **Shared-credential fan-out:** checked success, shared rejection, preserving a different newly saved endpoint, preserving a caller with a superseding refresh credential, and persistence before callers resume. No additional defect found in those cases.
- **30-second deadlines:** checked stalled fetches, stalled bodies for both redemption and refresh, single-use redemption, refresh-entry release, late redemption success after timeout, and a late old refresh after a newer successful rotation. No credential mutation occurs from either late result. The one-time code is fetched once.
- **Exact matcher:** the supplied matcher enforces the intended scheme/host/path/port/userinfo/fragment constraints; explicit port 80 is equivalent to the registered default port. It still accepts empty values and arbitrary state. JavaScript rejects those values, but only after the disruptive reload and pending-record removal. No expected-state binding exists in native code.
- **Token-mode entry:** a separate real ungated gateway smoke passed onboarding, save/reload, connected composer at desktop and phone widths, session-token REST without Bearer, and zero page errors. Initial scratch-rig attempts failed because the token environment variable was wrong and the fresh session store was uninitialized; after configuring `HERMES_DASHBOARD_SESSION_TOKEN` and initializing the scratch `SessionDB`, the check passed. These setup failures are not attributed to the app.

### E2E assertions and README corrections

The requested E2E assertion changes **landed** in `app/scripts/gated-signin-e2e.mjs`:

- Every protected REST request must carry exactly `Bearer <saved access token>` and have no session-token header. A focused check of the actual predicate rejects both headers together, Basic auth, and the wrong access token.
- The selected live, receiving socket must use the prefixed `/api/ws` path and the saved token. Focused predicate checks reject the wrong path and wrong token.
- Public exclusions include the gateway path prefix. Prefix-aware cases were checked directly; a live gateway mounted under `/hermes` was not exercised.
- Logout now checks reload, the Gateway screen, saved credentials, routed page/server socket closure, old-token reopening, and page errors.

Live run of the committed E2E, against a fresh real basic-auth gateway on `127.0.0.1:19749` and freshly built preview on `127.0.0.1:4187`, exited 0:

```text
REST: 14 authed requests, 14 with exactly "Bearer <saved access token>" and no session-token header
WebSocket: /api/ws open, receiving; token = saved access token: true
sign-out: reloaded=true, Gateway screen=true; stored token cleared;
2/2 open pre-logout sockets closed (page + server side);
0 reopened with the old token; 0 page errors across the reload
GATED E2E OK
```

The browser route still stands in for native callback interception. This is evidence for gateway protocol, renderer boot, header selection and client teardown; it does not execute Java or verify Android origin isolation.

README corrections also **landed**: embedded-agent deviation, Java-interface exposure, local logout versus server-side revocation, separate bounded OAuth exchanges, and stronger E2E assertions are now described. Three claims still need attention: native compile/test results rely on untracked files; the callback description overstates binding to the active authorization; and the listener-failure limitation incorrectly says the UI uses no Capacitor plugins. The earlier historical round-16 navigation description also remains broader than the current behavior, although the new round-17 section explains the updated arming rule.

### Verification and reproducibility

| Check | Result |
| --- | --- |
| `npm run typecheck` on exported revision | Passed. |
| `npm run build` on exported revision | Passed. |
| All four committed platform test files plus `src/app/open-session.test.ts`, with nine additional review checks | **6 files, 93 tests passed**: 84 committed checks and 9 review checks. One review check deliberately verifies the surviving wrong-state cancellation; its passing is evidence of that bug, not correctness. |
| Unchanged round-16 review probe, separate run | **4 expected reproduction failures, 1 control passed.** |
| `node --test scripts/smoke-classifier.test.mjs` | **8 passed.** |
| Clean committed native compile/unit-test invocation | **Failed** at Java compilation: missing `HermesOauthPlugin` and `OauthCallback`. |
| Same native invocation after adding copies of the three untracked Java files to the temporary tree | Passed; `OauthCallbackTest`: **2 tests, 0 failures/errors**. This does not repair or validate the committed file set. |
| Native activity source harness, four bridge configurations | Initial foreign-interface removal and navigation-shape controls passed; **wrong-state interception reproduced in all four**, and **listener-throw restoration loss reproduced**. Framework behavior is stubbed, not device-tested. |
| Corrected committed gated E2E | Passed against real basic-auth gateway, including logout teardown. |
| Original round-16 browser/RPC probe | Execution context destroyed by logout reload; not counted as a passing E2E. |
| Focused E2E predicate checks | Passed positive and negative Bearer/path/token cases. |
| Separate token-mode browser smoke | Passed after scratch-gateway setup corrections. |
| `git diff --check` | Clean. |

Temporary evidence is retained under `/tmp/hermes-r17-cxsol-*`: `original-probes.log`, `expanded-tests.log`, `native-committed.log`, `native-supplemented.log`, `native-probe.log`, `e2e.log`, `original-live-probe.log`, and `token-smoke-final.log`. Additional checks are in the temporary export's `app/src/platform/r17-review-probe.test.ts`; the native harness is generated by `/tmp/hermes-r17-cxsol-native-probe.py`; focused E2E checks are `/tmp/hermes-r17-cxsol-e2e-assertions.mjs`.

No APK was installed or run on a device/emulator. No implementation fixes are included. Approval requires a buildable committed native file set, active-state callback binding, and restoration of the actual fallback bridge used by Capacitor.
