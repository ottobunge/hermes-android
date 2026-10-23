## Verdict: REJECTED

Reviewed `7a7812b408c4d19eab614a61d95a25669018c6ff` against `9a7843e`, including all ten changed files and their renderer/Capacitor callers. The basic-auth happy path works against a real gateway. Logout, refresh ownership, and native trust boundaries need fixes before approval. Implementation files were left unchanged.

1. **[P1] Logout leaves authenticated sockets usable, and an in-flight refresh can restore the running credential.**

   Locations: `app/src/platform/bridge.ts:487–513`; `app/src/platform/oauth.ts:252–278`; renderer sign-out caller `app/src/app/settings/gateway-settings.tsx:760–790`.

   Logout clears two gateway objects and localStorage, then reports `connected: false`. It does not tear down the renderer's existing WebSockets or reload the page. These sockets authenticated during their handshake and do not consult the cleared gateway object before subsequent RPCs. The settings caller only refreshes settings state and displays the signed-out notification.

   **Live reproduction:** completed the real basic-auth sign-in, called `window.hermesDesktop.oauthLogoutConnectionConfig(base)`, then sent `session.list` on the already-open renderer socket. The gateway returned a successful JSON-RPC result while the saved token was absent:

   ```json
   {"openAfterLogout":true,"reply":{"hasResult":true},"storedTokenPresent":false}
   ```

   There is also an independently reproduced race: start an API request whose 401 initiates refresh; hold the refresh response; log out; release a successful refresh response. The unconditional `Object.assign(gateway, ...)` restores the booted object's access/refresh tokens. The original request retries successfully, and a subsequent `bridge.api()` succeeds, although storage still reports signed out. The persistence guard protects disk, not the running client.

   This exceeds the documented server-side revocation limitation: the client itself keeps working after local logout. Invalidate pending refresh results and end all authenticated client connections. Given this port's existing page-lifetime model, clearing credentials followed by a controlled reload is a small option; verify that no old refresh or socket survives the transition. Add a logout-during-refresh check and a real open-socket logout check.

2. **[P1, conditional on WebView capabilities] Remote sign-in navigation can expose Capacitor's native bridge to foreign content.**

   Locations: `app/android/app/src/main/java/com/bunge/hermes/MainActivity.java:61–67`, particularly the security assumption at lines 28–29; `app/README.md:344–346`.

   The client keeps gateway/IdP documents in the application's bridge-bearing WebView. In the pinned Capacitor 8.5.3 source, `MessageHandler.java:26–41` uses origin-scoped `addWebMessageListener` when supported, but falls back to `webView.addJavascriptInterface(this, "androidBridge")` when that feature is unavailable or listener installation throws. Its annotated `postMessage` method dispatches plugin calls without checking the calling origin. Limiting injection of the JavaScript bootstrap with `addDocumentStartJavaScript` does not limit this Java interface.

   On that fallback path, a foreign page can directly invoke, for example:

   ```js
   androidBridge.postMessage(JSON.stringify({
     callbackId: 'foreign-page', pluginId: 'CapacitorHttp', methodName: 'get',
     options: { url: 'https://example.com/' }
   }))
   ```

   `CapacitorHttp` is registered as a core plugin and its native request method is present regardless of whether automatic fetch interception is enabled. Android documents that `addJavascriptInterface` exposes the object to every frame without caller-origin verification. This is a source-backed conditional finding, not a device-tested exploit. The project supports API 24+, and this change adds no feature requirement or fallback exclusion. [Android native-bridge security guidance](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges).

   Keep authentication documents outside the app's native-bridge trust boundary, or explicitly prevent foreign navigation when that boundary cannot be enforced. Audit all interfaces when doing so: the installed core `CapacitorCookies` also unconditionally registers `CapacitorCookiesAndroidInterface`, whose annotated `setCookie(domain, action)` has no origin guard. A modern central message listener alone does not justify the README's blanket statement that foreign pages never see native interfaces. Exercise both the modern and fallback cases on Android.

3. **[P2] Single-flight refresh shares completion but updates only the first gateway object.**

   Location: `app/src/platform/oauth.ts:246–249,277`; relevant callers: `app/src/platform/bridge.ts:63–66,207–213,235–245,546–551`.

   `refreshes` is keyed by refresh-token string. A second object holding that same credential receives the first caller's `Promise<void>`, but the refresh closure mutates only its original `gateway`. This occurs in real callers: REST uses the cached booted object, while settings tests and registry tests obtain fresh objects from `loadGateway()`.

   **Reproduction:** issue concurrent `gatewayApi()` calls with two distinct gateway objects containing identical access/refresh tokens. Both initial responses are 401; release one successful refresh. Only one refresh is sent, but results are `['fulfilled', 'rejected']`: the first object retries with the new access token; the second retries with the obsolete token and gets another 401. The committed concurrency test passes the same object twice and misses this case. A failed refresh likewise clears only its owning object.

   Share the refresh result and apply it to every still-current caller, or route these paths through a canonical credential owner. Preserve the existing protection against overwriting a different saved gateway, and prevent stale results from undoing logout.

4. **[P2] Token exchange and refresh have no bounded timeout, including response bodies.**

   Locations: `app/src/platform/oauth.ts:188–193,254–269`; `app/src/platform/entry.ts:17–36`; `app/src/platform/api-transport.ts:161`.

   Both OAuth fetches bypass the transport's abort controller. A gateway that accepts a request and stalls can leave code redemption pending indefinitely. Entry waits for that promise before mounting either onboarding or the renderer, so the user gets an empty app without a retry surface. A stalled refresh remains in the single-flight map and holds subsequent refresh-dependent API/connection calls. The request's `timeoutMs` does not bound this leg.

   **Reproductions with fake timers:** code exchange remained unresolved after 60 seconds with no `signal`; an API request configured with `timeoutMs: 25` also remained unresolved after 60 seconds once it reached refresh. A response that stalls during `.json()` is similarly unbounded. Add a bounded exchange covering headers and body, and ensure timeout releases the refresh entry and lets boot show a useful failure. Do not automatically replay a one-time code exchange.

5. **[P2] The native callback matcher is unrelated to whether a sign-in is active or to its registered redirect.**

   Locations: `app/android/app/src/main/java/com/bunge/hermes/MainActivity.java:50–67,87–93`.

   The callback branch executes before any `signingIn` check. Any main-frame HTTP URL with host `127.0.0.1`/`::1` and a `code` parameter qualifies, with any port, path, userinfo, fragment, and no required state. For example, `http://127.0.0.1:8123/unrelated?code=x` forces an app reload with `oauth-code=x&oauth-state=null` even while `signingIn` is false. This also hijacks legitimate unrelated loopback links. During a real sign-in, a foreign document can use such a URL to abort it: `takePending()` deletes the pending record before the state mismatch is rejected.

   Separately, any HTTP(S) host with a path ending in `/auth/native/authorize` can set `signingIn`, without a pending app-initiated request. Subsequent arbitrary HTTP(S) destinations then stay inside the WebView until callback/app-origin navigation clears the flag. The app-origin reset itself is sensible, but the flag is not evidence of a legitimate flow.

   Bind interception to an app-initiated pending authorization and its expected redirect/state; compare the complete permitted redirect components. The current JS always requests `http://127.0.0.1/`, so accepting every loopback port/path/address is unnecessary. Add native negative cases for idle callbacks, wrong state/path/port, and foreign authorize navigations. **This is navigation hijacking/cancellation, not demonstrated token injection:** the JavaScript state check and PKCE still prevent an arbitrary callback from saving credentials.

**Other requested review areas**

| Area | Assessment |
| --- | --- |
| PKCE and state | Correct 32-byte cryptographic randomness, 43-character base64url verifier, SHA-256 S256 challenge, independent random state, and exact state equality before redemption. Pending data is removed before network work, making completion single-use. A valid expired pending record is rejected; an additional review check confirmed this. |
| Pending-record validation | Only `state` and `verifier` types are checked. Missing/non-numeric `createdAt` makes the TTL calculation ineffective; future timestamps extend its lifetime. Validate finite timestamp/base URL as a small robustness improvement. This is local-storage corruption/hardening, not an independent remote authentication bypass. |
| Transport headers/retry | Production `gatewayHeaders()` selects exactly one auth header. Legacy records without `authMode` still select the session-token header. A second 401 after the OAuth retry propagates; token mode does not refresh. The same-object concurrent and late-401 logic is reasonable. Issues 3–4 concern refresh ownership and liveness. |
| Storage and expiry | `loadGateway()` preserves OAuth fields and finite epoch-second expiry. Connection/WS creation refreshes within 60 seconds of expiry; refresh rejection clears credentials for its owning object. localStorage is app-private, unencrypted storage accessible to app-origin JavaScript. Acceptable only for the documented debug/sandbox threat model, with app compromise, backups and rooted-device access outside that protection. It is not equivalent to desktop OS secret storage. The README discloses this existing debt, though `secureTokenStorage: true` remains an overstatement. |
| Entry completion | Callback parameters are deleted with `replaceState` before redemption, while other query/hash data is preserved. State mismatch/missing pending does not contact the token endpoint or replace an existing gateway; it leaves a notice. A prior gateway still boots on failure. Issue 4 blocks boot if redemption never completes. |
| Renderer/onboarding regressions | `diff -qr upstream/apps/desktop/src app/src` reports only `platform/`. All renderer changes are confined to the platform layer. Drawer code is unchanged. Onboarding adds credential copy and a one-shot notice read outside StrictMode rendering. Existing token-mode, layout and session checks pass; a fresh visual token-mode smoke was not run in this review. |
| README | Provider probing, token-mode compatibility, protocol shapes, the browser callback stand-in, and absence of device testing are described accurately. Local logout/full-fidelity and whole-exchange-timeout claims need correction per findings 1 and 4; native-origin isolation needs correction per finding 2. |

**Test quality and remaining gaps**

`oauth.test.ts` contains useful behavioral checks, not just implementation snapshots: it exercises public functions, verifies requests and persisted state, and compares the PKCE digest with Node's independent hash implementation. Its concurrency case uses one shared object; logout checks only immediate storage/header effects. It lacks cross-object refresh, logout/refresh races, live socket teardown, proactive-expiry refresh, stalled OAuth responses, expired-pending rejection, and callback replay tests. The five temporary review checks reproduced findings 1, 3 and 4 and verified expired-pending rejection.

`gated-signin-e2e.mjs` is a real integration test for onboarding, gateway login, code redemption, storage, URL cleanup and live connectivity. It does not execute Java or validate Android navigation/Back behavior: the Playwright route implements the callback conversion itself. It exercises basic_auth, not an external OAuth provider.

Its assertions also overclaim two properties:

- At lines 43–45, any truthy `authorization` is classified as `bearer`, even when `x-hermes-session-token` is also present. A direct check with both headers returns `bearer` and passes the predicate at line 101. Require an actual Bearer value and independently assert absence of the session-token header.
- At lines 85–88/102, an open socket receiving frames qualifies without checking its path or `token` query parameter. Assert `/api/ws` and that the query token matches the saved access token. Real gated-server acceptance is useful evidence, but is not that explicit assertion. Public-path exclusions also need prefix awareness for a gateway mounted under `/hermes`.

The README acknowledges embedded-WebView provider restrictions. Calling the client fully RFC 8252 compliant would still be inaccurate: section 8.12 requires external user agents for native OAuth authorization. This report treats the brief's whole-WebView design as intentional and identifies the standards/documentation limitation separately from the implementation defects above. [RFC 8252, section 8.12](https://www.rfc-editor.org/rfc/rfc8252.html#section-8.12).

**Verification performed**

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npx vitest run src/platform src/app/open-session.test.ts`: 6 files, 83 checks passed while the five temporary review checks were present: 78 committed checks plus 5 review checks. The reproduction checks assert the observed bugs, so their passing does not establish correctness.
- `node --test scripts/smoke-classifier.test.mjs`: 8 passed.
- Original `scripts/gated-signin-e2e.mjs` against an isolated real basic-auth gateway on `127.0.0.1:19739`, freshly built app preview on `127.0.0.1:4186`: passed, zero page errors. Saw Bearer REST, saved access/refresh tokens, cleaned callback URL and an open receiving WebSocket.
- Separate instrumented live logout run: successful `session.list` after logout as quoted above. That instrumented run subsequently exited 1 with an uncaught signed-out error from the still-running renderer; it is not counted as a passing E2E.
- `git diff --check`: clean. Temporary test source was removed from the repo after execution; a copy remains at `/tmp/hermes-r16-review-probe.test.ts` (restore under `app/src/platform/` to rerun). The instrumented browser probe is `/tmp/hermes-r16-gated-review.mjs`.

Native findings were checked against the actual pinned Capacitor Java sources and the activity implementation. No APK/device/emulator test or fresh Java compilation was performed in this review. No implementation fix is included.
