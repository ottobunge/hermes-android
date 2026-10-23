## Verdict: APPROVED_WITH_NITS

Reviewed `git diff 5ad85ea..ffc7c33` (`ffc7c33660dd2f614671fd614e8ef0b46e1b72ba`) against `arsenal-hermes-android-r17-review-cxsol.md`. **All three round-17 blockers are closed.** The committed native sources compile, wrong-state loopback callbacks preserve the active sign-in, and completion/cancellation restore the original interface set, including Capacitor's listener-installation-failure fallback. One nonblocking validation defect remains below.

Review only: no implementation changes. Builds and probes ran in `/tmp/hermes-r18-cxsol-tree`, exported with `git archive ffc7c33`. Mutations were confined to that temporary export and restored; all 11 changed files were subsequently compared byte-for-byte with `git show ffc7c33:<path>`.

### Nonblocking finding

**[P3] Reject a missing authorize URL instead of throwing an uncaught null-pointer exception.**

Locations: `app/android/app/src/main/java/com/bunge/hermes/SignInSession.java:88`; `HermesOauthPlugin.java:24–28`.

With a valid state and redirect but an absent/null `url`, `new URI(authorizeUrl)` throws `NullPointerException`. The plugin catches only `IllegalArgumentException`, so it does not reject the call. Pinned Capacitor's `Bridge.callPluginMethod` escalates an exception from a plugin method as a `RuntimeException` on its task handler. The current typed renderer always supplies a URL, so this does not block the intended sign-in flow or reopen any of the three blockers.

An independent JVM probe against the exported `SignInSession` reproduced:

```java
SignInSession.validate(null, "expected", SignInSession.REDIRECT_URI);
// NullPointerException, rather than the IllegalArgumentException handled by the plugin
```

Add an explicit null-URL validation guard and include that case in the existing invalid-begin test. No fix is included in this review.

### Closure of the three blockers

| Round-17 blocker | Independent verification | Result |
| --- | --- | --- |
| Missing committed native sources/tests | `git ls-tree` contains `HermesOauthPlugin`, `OauthCallback`, `SignInSession`, and both OAuth JUnit classes. Compiled the archive export without supplementing any application Java source. | **Closed.** Native compile and all 9 JUnit tests pass. |
| Wrong-state callback cancels an active authorization | Replayed the actual `GatewaySignInClient.begin()` / `shouldOverrideUrlLoading()` path using framework stubs. Wrong, empty, and superseded states produce no app load, no delegation to Capacitor, and no interface restoration. A subsequent genuine callback completes and restores the interfaces. | **Closed.** The active expected state and detached set survive the attack. |
| Listener-throw fallback is removed but not restored | Replayed completion, cancellation, and further sign-ins with modern, unsupported-feature, legacy, and listener-throw transport outcomes. Compared interface names **and object identity** before/after, including four Http/Cookies plugin-presence subsets per transport configuration. | **Closed.** Exactly the original Java interface objects return; a modern configuration gains no Java `androidBridge`. |

The new pure-Java session snapshots the interface set once when detaching. Re-entering `begin()` while detached replaces the expected state without overwriting that snapshot. The adapter obtains Http/Cookies instances from their plugin handles; both pinned plugin `load()` methods install the corresponding Java interfaces. Capacitor's pinned `MessageHandler` installs the same Java `androidBridge` for unsupported-feature, legacy, and listener-throw cases, so those three outcomes appropriately share the same restoration path.

For the active-flow attack, the decisive change is native interception **before an app document loads**. The JavaScript completion function still consumes pending state when directly presented with an invalid app-origin callback; the loopback attack no longer reaches that function. The activity probe verifies the missing app load and missing delegation. Separate JavaScript checks verify that the preserved pending record can redeem the genuine code exactly once with its original verifier.

### Regression checks

- **Completion and replay:** matching main-frame state restores interfaces before loading the app callback, clears the armed state, preserves code encoding (`real%2B1` becomes code `real+1` in the token request), and does not trigger an extra cancellation reload. A replay cannot complete natively a second time; JavaScript also refuses a second redemption.
- **Cancellation and restart:** returning to the app origin disarms the session, restores interfaces, and queues exactly one reload. The next app-origin start queues none. Second and third sign-ins work after both completion and cancellation, including the modeled listener-throw fallback. Replacing an already active sign-in rejects the old state's callback and completes the new one without losing the interface snapshot.
- **Expiry:** `SignInSession` has no native timer; pending-age enforcement remains in `completeOauthRedirect`. Advancing the renderer clock by 31 minutes and supplying a correctly bound callback rejects it before fetch, clears pending state, and saves no token. A fresh sign-in subsequently succeeds. This is renderer rejection on return, not automatic native cancellation at 30 minutes.
- **Other navigation controls:** idle callbacks and foreign authorize URLs cannot arm the session. Subframe callbacks defer to Capacitor and do not complete it. Wrong port/path, missing state, userinfo, and fragments do not rewrite the app. Foreign HTTP(S) login/IdP navigations remain in the detached WebView.
- **Reflection:** inspected the actual pinned Capacitor 8.5.3 `MessageHandler` and `Bridge` implementations. Only the modern listener assigns `javaScriptReplyProxy`; the Java fallback leaves it null. Modern plugin dispatch queues work, and `begin()` is posted back to the main thread, so its probe runs after the listener callback has assigned the proxy, including on a first message. The JUnit field-existence checks pass against the real dependency classes. Release minification is currently disabled. This remains coupled to Capacitor internals, with an explicit test guarding the pinned field names.
- **Removing `androidx.webkit`:** the removed dependency is the app module's direct declaration. Capacitor still declares WebKit as its own dependency; its listener implementation remains available. The changed activity no longer imports `WebViewFeature`. Native compilation and the real-class reflection tests pass with this arrangement.

### Coverage and negative controls

The committed tests are present and executable: `OauthCallbackTest` has 2 tests, `SignInSessionTest` has 6, and the existing example adds 1. The session tests cover preservation after wrong state followed by genuine completion, repeat sign-in after completion/cancellation, idle/subframe handling, invalid begin parameters, transport detection, and pinned reflection fields. The Vitest addition checks that the pending state and exact redirect URI accompany the authorize URL.

Reran the claimed mutations independently, with assertion failures rather than setup/compile failures:

| Temporary mutation | Observed failure |
| --- | --- |
| Remove native expected-state comparison | 1 of 6 session tests fails: expected `BLOCK`, received `COMPLETED`. |
| Make the reflected transport probe return false | 1 of 6 session tests fails at the fallback/listener-installation-failure assertion. |
| Omit the state/redirect argument from `startOauthLogin`'s navigation call | The focused committed Vitest test fails: expected the pending state/redirect object, received `undefined`. |

After restoring the original bytes, the native compile/unit-test gate passes again with all 9 tests, and the focused Vitest test passes again.

### README and verification evidence

The README corrections landed: the current behavior explicitly binds callbacks to expected state, records/restores the interface set, and handles listener installation throwing. The incorrect statement that the UI uses no Capacitor plugins is removed. Historical round-17 compile evidence is labeled as relying on untracked working-tree files, and the old round-16 interception description is marked superseded. The README also correctly separates browser E2E coverage from native JUnit coverage. Its staged-index wording describes the implementation-time gate; this review independently validates the actual commit.

| Check on the exported revision | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run build` | Passed. |
| `npx cap update android`; native compile and unit tests under `nix develop` | Passed from committed application sources; generated Cordova project supplied by Capacitor CLI. `cap sync` also completed after the web build. |
| `npx vitest run src/platform src/app/open-session.test.ts` | **6 files, 88 tests passed:** 84 committed tests plus 4 temporary lifecycle checks. |
| `node --test scripts/smoke-classifier.test.mjs` | **8 passed.** |
| Activity source replay | Four transport configurations × four plugin subsets passed; complete/cancel/restart, attack, and navigation controls described above. |
| Required native negative controls and extra renderer mutation | All produced the expected assertion failures; restored checks pass. |
| Null-URL validation probe | Reproduced the nonblocking finding above. |
| `git diff --check 5ad85ea..ffc7c33` | Clean. |

The native gate was:

```sh
# In /tmp/hermes-r18-cxsol-tree/app, with installed node_modules linked:
npx cap update android
nix develop --command bash -c \
  'cd android && ./gradlew --no-daemon :app:compileDebugJavaWithJavac :app:testDebugUnitTest'
```

Evidence is retained in `/tmp/hermes-r18-cxsol-*`: `native-clean.log`, `native-restored.log`, `native-probe.log`, `build.log`, `typecheck.log`, `tests.log`, `lifecycle-tests.log`, `classifier.log`, the mutation logs/XML, `typescript-restored.log`, and `null-validation.log`. The independent activity model is generated by `/tmp/hermes-r18-cxsol-native-probe.py`; mutation replay is `/tmp/hermes-r18-cxsol-mutations.py`. Additional JavaScript checks are in the temporary export's `app/src/platform/r18-review-probe.test.ts`.

No APK was installed or run on a device/emulator for this review. The activity model uses framework stubs and models the result of listener installation failure; pinned dependency source inspection supplies the actual constructor behavior. Browser E2Es were not rerun in this closure review, and their historical README counts are not presented as new observations. These limits do not change closure of the three source/build blockers.
