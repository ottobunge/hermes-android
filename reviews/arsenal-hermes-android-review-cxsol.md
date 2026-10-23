# Hermes Android phase 1 review — cxsol

Reviewed HEAD `bfbd5b93146da131670c34adccca23bda1bc0c12` on 2026-10-22 against `run/briefs/review-panel.md`. No source code was changed and nothing was pushed. The admitted native-project/toolchain, Keystore, attachment persistence, unsupported connection modes, and full-suite failures are not findings below.

The renderer copy and entry seam are well contained, and typecheck, build, and all ten platform tests pass. Approval is blocked by gateway credential isolation and connection switching defects. The bridge also has an incomplete HTTP timeout, the production wordmark font fails to load, and the advertised HTTP support needs another Android network setting.

## Findings

### 1. [P1] Registry edits can send an existing gateway's token to a different host

**Location:** `app/src/platform/bridge.ts:383–385` (`connections.save`).

Editing the existing remote connection in the reused Devices/connection-registry panel permits changing its URL while leaving the token box empty. The renderer deliberately omits `payload.token` in that case (`app/src/app/settings/connections-registry.tsx:442–446`). The bridge unconditionally inherits `current.token`, even when the normalized endpoint changed. Subsequent REST requests and newly resolved WebSocket URLs send gateway A's credential to gateway B. A typo or an endpoint under different administration therefore discloses a live bearer-equivalent credential.

**Reproduced:** saved `{httpUrl:'https://a.example', token:'FAKE_A_TOKEN'}`, then called `connections.save({id:'gateway', kind:'remote', url:'https://b.example', label:'B'})`. `loadGateway()` returned `{httpUrl:'https://b.example', token:'FAKE_A_TOKEN', name:'B'}`. These were synthetic credentials; no requests were sent to those hosts.

**Minimum correction:** share the endpoint-sensitive token inheritance already implemented by `coerce()` at `bridge.ts:149–156`; require a new token when the endpoint changes. Check this at the bridge boundary, not only in the form. Add a cross-host omitted-token regression check.

### 2. [P1] Registry saves switch REST destinations without switching the active chat socket

**Location:** `app/src/platform/bridge.ts:378–388` (`connections.save`).

This supported save path writes the new endpoint/token immediately but neither reloads the page nor emits a connection lifecycle event. `api()` reads localStorage for every request, while existing `HermesGateway` instances retain the connection descriptor and WebSocket resolved before the edit. Publishing the new registry in `ConnectionsRegistrySection` only changes the registry atom; socket invalidation is wired through the absent `connections.onChanged` subscription (`app/src/app/gateway/hooks/use-gateway-boot.ts:1139`).

Consequently, after editing a gateway, REST settings/session calls can target B while chat RPCs/events still use A, with the same constant connection id `gateway`. Token rotation likewise leaves the old authenticated socket alive. This contradicts the documented hard reload on gateway changes and risks operating on the wrong server.

**Reproduced with mocked fetch:** resolve connection A, save connection B with a fresh B token, then call `api({path:'/api/config'})`. The retained descriptor was `wss://a.example/api/ws?token=FAKE_A`, the REST call was `https://b.example/api/config`, no reload occurred after 450 ms, and `connections.onChanged` was absent. Source tracing confirms the renderer does not close that socket on registry publication.

**Minimum correction:** route material registry edits through the same validate/save/reload lifecycle as `applyConnectionConfig`; label-only edits can remain in place. Verify that both transports move together. This is independent of finding 1: providing a fresh token prevents credential inheritance but does not repair the split connection.

### 3. [P2] The REST timeout stops at response headers and cannot abort a stalled body

**Location:** `app/src/platform/api-transport.ts:55–74`.

`fetch()` resolves when response headers arrive. The `finally` clears the AbortController timer before `res.text()` is awaited, so a gateway/proxy which sends headers and stalls the JSON body leaves the request pending indefinitely. Body read failures also bypass the transport-error wrapping and GET retry policy. Upstream `fetchJson` keeps the Node request timeout active while collecting the response body (`upstream/apps/desktop/electron/main.ts:5657–5760`).

**Reproduced:** a fetch double returned a response immediately with a never-resolving `text()` promise. With `timeoutMs:20`, the API promise was still pending after 150 ms and its signal was not aborted. The existing timeout test only stalls `fetch()` itself and misses this case.

**Minimum correction:** keep the timer through body consumption, classify abort/body transport failures in the same attempt, and clear the timer after completion. Add one headers-arrived/body-stalled check; retain the no-ambiguous-POST-retry rule.

### 4. [P2] The production build loses the desktop wordmark font

**Location:** `app/src/styles.css:63–68`; resolve the relocation in the port build configuration/assets rather than changing vendored renderer code unnecessarily.

The unchanged desktop stylesheet references `../../../node_modules/@nous-research/ui/dist/fonts/Collapse-Bold.woff2`. That was a monorepo-relative path; this app installs its dependencies under `app/node_modules`. Vite reports that the font did not resolve and leaves the URL in the output. The `.wordmark` style uses this face at weight 700, so the shipped app falls back to a different font at tablet and phone widths despite the desktop-parity claim.

**Reproduced against this review's production build:** Chromium requested `/node_modules/@nous-research/ui/dist/fonts/Collapse-Bold.woff2`; Vite preview returned its HTML fallback (`200`, `text/html`). `document.fonts.load('700 32px Collapse')` rejected with `A network error occurred.` The tablet/phone screenshots show the fallback lettering. A successfully emitted Collapse font in the optional intro chunk does not make this broken global font-face URL valid.

**Minimum correction:** resolve/rewrite the package asset from the standalone app's installed dependency at build time, then verify the production font request and loaded face. A successful bundle exit is insufficient for visual parity.

### 5. [P2] Mixed-content permission alone does not enable the advertised HTTP gateways on Android

**Location:** `app/capacitor.config.ts:7–11`; associated build instructions in `app/README.md:124` and the Android setup section.

`android.allowMixedContent:true` only sets WebView's mixed-content mode. The config supplies neither `server.cleartext:true` nor a native manifest/network-security policy allowing cleartext. Capacitor 8.5.3's Android template has no `usesCleartextTraffic` override; its CLI documents cleartext as disabled by default since API 28. The installed CLI separately emits `android:usesCleartextTraffic="true"` from `server.cleartext` when generating the merged Cordova manifest. Its Android library targets API 36. Following the README's plain `cap add`/sync/build procedure therefore does not establish the promised plain-HTTP access, independently of the already admitted absence of a native project.

**Evidence:** installed `@capacitor/android/.../Bridge.java:594–595` sets only `MIXED_CONTENT_ALWAYS_ALLOW`; `@capacitor/cli/dist/declarations.d.ts:577–589` describes the separate cleartext setting; `@capacitor/cli/dist/cordova.js:756–759` handles its manifest attribute. I did not build an APK or verify this on a device.

**Minimum correction:** explicitly choose and document a cleartext network policy for the supported LAN/tailnet use case, or require HTTPS. Verify HTTP REST and WS separately on Android; mixed-content and Android cleartext policy are distinct gates.

## Contract coverage and README accuracy

I used the installed TypeScript compiler AST to compare `Window.hermesDesktop` in `app/src/global.d.ts` with the typed bridge object, including nested members. There are **148 top-level members** and **277 declarations including nested members/containers**: 136 present, 141 absent (all optional or inside an absent optional namespace), and **zero missing required declarations**. `bridge: Bridge` plus the passing typecheck independently enforces required coverage. The appendix classifies every declaration; an absent imported API object also means its entire imported API is absent.

The README correctly describes the broad availability split, but its “every member”/“full fidelity” wording needs qualification:

- `profile.onDefaultChanged` is a required no-op subscription and is omitted from the table.
- Absent optional `connections.setLaunchMode`, `connections.setLastUsed`, `connections.updateManaged`, `connections.updateAll`, and `connections.onChanged` are omitted. So are `setDisableF12`, `setF12ShortcutActive`, and `onF12Shortcut`.
- `connections.setPrimary` is a success-shaped no-op that ignores the requested id; it is a stub under the one-gateway restriction. The fetch/storage/reload implementations are web equivalents for the supported subset, not literal Electron lifecycle parity. Findings 1–3 make the fidelity claim materially inaccurate today.
- The authentication header at README line 41 is wrong: the implementation sends **`X-Hermes-Session-Token`**, matching Electron's token mode, not `Authorization: Bearer`. The latter belongs to upstream native OAuth mode.
- `getRecentLogs` keeps 200 lines internally but returns the last **80**, not 200 as its table entry suggests. Only revalidation failures currently populate that bridge log.
- Optional absence does not universally mean “the UI hides.” Some callers fall back or show unavailable behavior. Similarly, browser Notification, clipboard, microphone, download, and external-window implementations are capability-dependent web equivalents; their existence is not Android device verification.

These documentation corrections are secondary to the findings. I do not count the explicit localStorage/`secureTokenStorage:true` admission as a new finding.

## Renderer provenance and startup order

`diff -rq upstream/apps/desktop/src app/src` returned exactly `Only in app/src: platform`. Thus all copied files, including `global.d.ts`, styles, renderer tests, and `AGENTS.md`, match the supplied reference; there are **no renderer modifications outside `src/platform/`**. This verifies identity against the supplied upstream tree, not independently against the remote release tag. `app/shared/src` also matches the vendored shared source; only package/build metadata is omitted from `app/shared`. `app/public` matches the upstream desktop public tree.

`index.html` correctly points to the platform entry. Its static dependency graph reaches the bridge's pure helpers and phone layout's leaf constants; those constants do not evaluate the renderer stores. `installBridge()` executes before the dynamic import of `main` or onboarding, and the phone style/listener installs once on ordinary page startup. Reusing the gateway panel and preserving the renderer is an appropriately small approach. The font defect demonstrates why byte equality alone does not establish runtime or visual equality after relocation.

## Gateway transport assessment

- URL normalization matches the upstream implementation: trim, default a missing scheme to HTTP, reject non-HTTP(S), strip query/hash and trailing slashes, preserve the deployment path prefix. WS derivation preserves host/port/prefix, maps HTTPS to WSS, and percent-encodes the token. Profile scoping retains an existing `?profile=` and otherwise adds the trimmed explicit scope. There is no apparent token-to-arbitrary-URL escape through an API path: the request URL is concatenated under the normalized gateway base.
- The single gateway's connection descriptors correctly identify remote/token mode and carry the token, WS URL, profile and stable gateway id. `getConnectionFor` identifies a shared registry remote. Ignoring alternate connection ids is the declared one-gateway subset, although the save path must still preserve isolation/lifecycle within it.
- Probe semantics agree with upstream: public status with `auth_required:true` selects OAuth; token mode otherwise. Onboarding/apply validates public status, authenticated sessions, then WS open when a token exists. `coerce()` itself protects against inheriting tokens across URL changes; the registry save path bypasses that protection. Tests with no token can report HTTP success without a WS probe; normal form validation requires a token, and `requireGateway()` refuses later use without one.
- JSON bodies, multipart field `file`, filename sanitation, content type and browser-managed multipart boundary are appropriate. Structured HTTP errors retain `.statusCode` and `<status>: <body>` wording. I separately checked 401/403/500 propagation and no HTTP-status retries. Redirects, including browser opaque redirects, are rejected; HTML fallbacks and malformed JSON have useful diagnostic errors. Browser redirect opacity loses upstream's Location-specific hint, an acceptable platform limit.
- GET/HEAD/OPTIONS retry transport failures at most twice; mutating requests are never retried after ambiguous browser fetch failure. This is a sensible stricter version of Electron's never-sent policy. Finding 3 is the exception to timeout/body-failure equivalence.
- The brief's `json-rpc-gateway.ts` reference is the **WebSocket** client, not the REST fetch implementation. It is copied unchanged into `app/shared/src`, and the unchanged renderer's `HermesGateway extends JsonRpcGatewayClient` still supplies channel request ids, errors, request timeouts, heartbeat, reconnect replay/barriers, and server-request handling. `api-transport.ts` does not replace those semantics; it replaces Electron's REST helper. Finding 2 breaks coordination between these otherwise separate transports.

## Security assessment

**LocalStorage:** app-private WebView storage is a reasonable disclosed prototype compromise, with medium at-rest risk depending on device/backup/debug access. It is not a keychain. The consequence of script execution in the app origin is high: a script can read the gateway credential and call the bridge as the user. `secureTokenStorage:true` suppresses upstream plaintext warnings and must not be interpreted as encryption; the README admits this. No new finding is assigned for the known storage gap.

**Script/content surfaces:** sampled HTML artifacts and inline widgets use opaque sandboxed frames; remote HTML uses an empty sandbox; SVG passes through DOMPurify; Mermaid initializes with strict security; normal social markup escapes input. I did not find an arbitrary message-to-parent-script injection in those inspected paths. However, inherited `social-embed.tsx` deliberately loads Instagram/TikTok/Twitter JavaScript into the **parent document**, without SRI or a top-level CSP. Those providers execute with access to localStorage and the bridge. This is an actual trust grant, even without an XSS exploit, and a provider/supply-chain compromise has credential impact. Third-party embeds are not all isolated just because artifact frames are sandboxed. Runtime desktop-plugin source APIs are absent, reducing another script-loading surface. This is a source review, not an exhaustive exploit audit.

**Network:** enabling mixed content globally also permits insecure subresources; it is not scoped to the chosen gateway. HTTP token headers and WS query tokens are observable to the network unless protected by a trusted tunnel. HTTPS/WSS should be preferred, including for a self-hosted gateway. The WS query credential is inherited token-mode protocol behavior; reverse-proxy access logging needs to treat it as a secret. Finding 1 is a concrete credential disclosure beyond the admitted storage limitation. The app leaves Capacitor navigation allowances at their default rather than admitting arbitrary external pages into the host origin.

## Phone layout and tablet parity

The CSS rules are correctly enclosed by `max-width:767.98px`. Pointer handling uses the stricter upstream collapse condition, `max-width:639.98px`, and requires an actual overlay. Thus the handler has no effect at tablet widths or on the documented 640–767px docked rails. No off-by-one tablet mutation was found. The titlebar offset resolves to 34 px at the normal root font size; wordmark minimum and statusbar scrolling are phone-only. The generated tablet and drawer screenshots were inspected.

The smoke verifies opening the left drawer with touch, dismissing outside, and zero document horizontal overflow. The close helper dispatches explicit close intents for available tab ids plus the sidebar/file-browser aliases, matching upstream's close-only-current-pane behavior. Dialog/menu/popper and titlebar targets are spared. Navigation dismissal relies on a changed hash/location after click; clicking a non-navigation control or the already-selected route intentionally does not close it. Swipes and the intermediate docked breakpoint are explicitly admitted limitations.

No accumulating document listener occurs in the normal single entry evaluation. There is no teardown/idempotence guard for repeated `installPhoneLayout()` calls, and a pointerdown that is cancelled before click leaves a one-shot listener on its target until a later click or node collection. Repeated cancelled gestures on a retained node can accumulate callbacks. These are low-impact hardening nits, not a demonstrated steady-state leak in the ordinary startup/tap flow. Right drawer, tab switching, popovers, cancelled gestures, rotation, system back and the software keyboard are not covered by the supplied smoke. Tablet source/layout parity holds; complete visual parity fails on finding 4.

## Verification and render-loop assessment

Executed during this review:

| Check | Result |
| --- | --- |
| `npm run typecheck` in `app` | PASS, exit 0 |
| `npx vitest run src/platform` | PASS, 1 file, 10/10 tests |
| `npm run build` | PASS, exit 0; unresolved Collapse font warning, deprecated chunk option/config-loader warnings |
| Recursive renderer/shared comparisons | Renderer differs only by `src/platform`; shared source identical |
| AST bridge inventory | No required member absent; full appendix below |
| Registry credential/switch and stalled-body harnesses | Reproduced findings 1–3 without contacting synthetic hosts |
| HTTP 401/403/500 and multipart fetch checks | Correct status shape, one attempt per status, multipart field/filename/content type/header correct |
| Production Chromium font check | FAIL, HTML returned for the font URL and font load rejected |
| Unmodified `app/scripts/smoke.mjs` at 1280, 820 and 390 px | Exit 1; all five screenshots reached, onboarding/phone drawer/overflow checks passed; uncaught getSnapshot errors remain |
| Full Vitest / Electron comparison / APK / Android device | Not rerun / not rerun / not built / not tested |

Smoke used Chromium 155 and preview on port 4274, with a temporary `hermes serve` home on port 19829 and an initialized empty scratch `state.db`. `hermes gateway run` declined to start another host-wide gateway because one was already running; therefore this was not a fully hermetic gateway-runtime comparison. No model turn was submitted. The first smoke attempt failed at reconnect on the scratch store's 503; after initializing the scratch store, the second reached all screenshot/drawer steps. I stopped the review-owned serve process afterwards. Screenshots are under `/tmp/hermes-cxsol-smoke` and are local, transient review evidence.

The completed run recorded eight errors on the desktop page and nine on the phone page over the script's observation interval. The desktop errors appear under both `onboarding` and `tablet` because the script adds two listeners to the same page. This agrees with the reported failure class, not a fixed 4–7 error bound. The script correctly returns failure on those page errors. It only logs ordinary `console.error` (including HTTP status failures), so “passes the DOM check” does not prove all backend calls worked. At 820 px it takes a screenshot after resizing rather than making another independent connected-surface assertion. It performs no screenshot comparison, provider-backed chat, attachment upload, profile-switch integration test, or Android lifecycle/permission test.

The README's attribution of the render loop to upstream is **credible and consistent with the inspected code**, and should not be relabeled an Android-only regression. The renderer/shared source is unchanged; the local comparison installation has the same assistant-ui core 0.2.23, react 0.14.24, tap 0.9.24, store 0.2.22 and React 19.2.7; tap's installed `useSyncExternalStore` actually contains the quoted error and 50-commit guard. Its identity comparison and the thread-list state/memoization path make the stated diagnosis plausible. The documented real-Electron reproduction with unchanged preload/main is the relevant control. I did not independently rerun that control or establish the exact internal notification trigger. “Upstream” establishes provenance, not harmlessness or proof that the entire application works after the exceptions. The smoke appropriately stays red.

The full-suite 64 failures are expressly untriaged, and remain so; host-load explanations are hypotheses, not evidence that the failures are safe. The default Vitest project includes the copied UI suite (with optional environment-supplied exclusions), and drops Electron tests as stated. Typecheck separately excludes one monorepo-fixture-dependent test; this does not exclude it from Vitest. No new test files or source fixes were introduced by this review.

## Requirements before a real APK

The configured `appId:'com.bunge.hermes'`, app name, `webDir:'dist'`, and default secure Android localhost origin are internally consistent, and all three Capacitor packages are pinned to 8.5.3. `android:debug` correctly describes build → sync → Gradle once a native project exists. The README accurately says there is currently no native project or APK; this is not a finding.

The later native step still needs generated/committed Android project files, installed SDK/JDK and compatible Gradle settings, real debug/release builds, signing and distribution setup. In addition to finding 5, verify microphone manifest/runtime permissions (the stock template declares only INTERNET), WebView clipboard behavior, native notifications/background delivery, actual image download handling (the installed bridge has no download listener), external-link intents, back navigation, network/CORS from `https://localhost`, safe areas/edge-to-edge insets and IME resizing. Browser `<a download>` and Notification calls are not proof those Android capabilities work. These are unverified release prerequisites under the stated phase-1 scope, not additional findings for the admitted missing native project. MIT attribution is present in the root license; later packaging must preserve it and dependency notices.

## Complete bridge inventory

F = full-fidelity behavior for the supported single token gateway; W = implemented web equivalent/subset, subject to findings and platform permission support; S = present stub/no-op/unavailable response; A = absent optional capability. Namespace/container rows summarize their implementations; nested rows give the individual classifications. Required/optional is inherited through optional parent namespaces. “Present” describes the implementation, not a successful Android device test.

Counts including containers: F = 3, W = 34, S = 99, A = 141.

| Member | Contract | Class | Bridge line |
| --- | --- | --- | --- |
| `getConnection` | required | W | 295 |
| `getConnectionFor` | optional | W | 296 |
| `getGatewayWsUrlFor` | optional | F | 303 |
| `getAgentRoster` | optional | A | — |
| `getProfileRoutes` | required | F | 322 |
| `revalidateConnection` | required | W | 304 |
| `touchBackend` | required | S | 321 |
| `getPoolLimits` | required | S | 324 |
| `setPoolLimits` | required | S | 325 |
| `getGatewayWsUrl` | required | F | 302 |
| `openSessionWindow` | required | S | 531 |
| `openSessionInTerminal` | required | S | 532 |
| `openWindow` | required | S | 533 |
| `openBrowserWindow` | required | S | 534 |
| `onBrowserPopoutClosed` | required | S | 535 |
| `claimAmbientCue` | required | S | 526 |
| `windowControls` | required | S | 536 |
| `windowControls.custom` | required | S | 536 |
| `windowControls.minimize` | required | S | 536 |
| `windowControls.toggleMaximize` | required | S | 536 |
| `windowControls.close` | required | S | 536 |
| `wakeIndicator` | optional | A | — |
| `wakeIndicator.getState` | optional | A | — |
| `wakeIndicator.setState` | optional | A | — |
| `wakeIndicator.onState` | optional | A | — |
| `petOverlay` | required | S | 537 |
| `petOverlay.open` | required | S | 538 |
| `petOverlay.close` | required | S | 539 |
| `petOverlay.setBounds` | required | S | 540 |
| `petOverlay.setIgnoreMouse` | required | S | 541 |
| `petOverlay.setFocusable` | required | S | 542 |
| `petOverlay.pushState` | required | S | 543 |
| `petOverlay.control` | required | S | 544 |
| `petOverlay.onState` | required | S | 545 |
| `petOverlay.onControl` | required | S | 546 |
| `introReveal` | optional | A | — |
| `introReveal.open` | optional | A | — |
| `introReveal.close` | optional | A | — |
| `introReveal.skip` | optional | A | — |
| `introReveal.ready` | optional | A | — |
| `introReveal.onSkip` | optional | A | — |
| `introReveal.onClosed` | optional | A | — |
| `chatOnboarding` | optional | A | — |
| `chatOnboarding.grow` | optional | A | — |
| `chatOnboarding.soloBoot` | optional | A | — |
| `hud` | optional | A | — |
| `hud.nativeDrag` | optional | A | — |
| `hud.windowing` | optional | A | — |
| `hud.windowing.clientPlacement` | optional | A | — |
| `hud.windowing.controlDrag` | optional | A | — |
| `hud.windowing.nativeDrag` | optional | A | — |
| `hud.windowing.solid` | optional | A | — |
| `hud.windowing.workspaceTransfer` | optional | A | — |
| `hud.open` | optional | A | — |
| `hud.close` | optional | A | — |
| `hud.setIgnoreMouse` | optional | A | — |
| `hud.beginMove` | optional | A | — |
| `hud.endMove` | optional | A | — |
| `hud.moveBy` | optional | A | — |
| `hud.setWorkspaceTransfer` | optional | A | — |
| `hud.setBounds` | optional | A | — |
| `hud.resetLayout` | optional | A | — |
| `hud.setFrost` | optional | A | — |
| `hud.setSession` | optional | A | — |
| `hud.onGoto` | optional | A | — |
| `hud.onChanged` | optional | A | — |
| `hud.onCursor` | optional | A | — |
| `hud.onGameOverlay` | optional | A | — |
| `screenshot` | optional | A | — |
| `hudModifier` | optional | A | — |
| `quickEntry` | required | S | 548 |
| `quickEntry.getSettings` | required | S | 549 |
| `quickEntry.setSettings` | required | S | 550 |
| `quickEntry.submit` | required | S | 551 |
| `quickEntry.dismiss` | required | S | 552 |
| `quickEntry.pushState` | required | S | 553 |
| `quickEntry.onState` | required | S | 554 |
| `quickEntry.onSubmit` | required | S | 555 |
| `quickEntry.onShown` | required | S | 556 |
| `getBootProgress` | required | S | 429 |
| `getConnectionConfig` | required | W | 333 |
| `saveConnectionConfig` | required | W | 334 |
| `applyConnectionConfig` | required | W | 339 |
| `testConnectionConfig` | required | W | 351 |
| `getSecretStorageEncryption` | required | S | 372 |
| `setSecretStorageEncryption` | required | S | 373 |
| `connections` | required | W | 376 |
| `connections.list` | required | W | 377 |
| `connections.save` | required | W | 378 |
| `connections.remove` | required | S | 390 |
| `connections.setPrimary` | required | S | 391 |
| `connections.setLaunchMode` | optional | A | — |
| `connections.setLastUsed` | optional | A | — |
| `connections.test` | required | W | 392 |
| `connections.updateManaged` | optional | A | — |
| `connections.updateAll` | optional | A | — |
| `connections.onChanged` | optional | A | — |
| `sshConfigHosts` | required | S | 374 |
| `sshResolveHost` | required | S | 375 |
| `probeConnectionConfig` | required | W | 352 |
| `oauthLoginConnectionConfig` | required | S | 370 |
| `oauthLogoutConnectionConfig` | required | S | 371 |
| `cloud` | required | S | 394 |
| `cloud.status` | required | S | 395 |
| `cloud.login` | required | S | 396 |
| `cloud.logout` | required | S | 397 |
| `cloud.discover` | required | S | 398 |
| `cloud.agentSignIn` | required | S | 399 |
| `profile` | required | W | 401 |
| `profile.getDefault` | required | W | 402 |
| `profile.setDefault` | required | W | 403 |
| `profile.onDefaultChanged` | required | S | 408 |
| `profile.get` | required | W | 409 |
| `profile.remember` | required | W | 410 |
| `profile.set` | required | W | 417 |
| `api` | required | W | 326 |
| `notify` | required | W | 485 |
| `requestMicrophoneAccess` | required | W | 486 |
| `readWindowBelow` | optional | A | — |
| `readFileDataUrl` | required | W | 511 |
| `readFileDataUrlForAttach` | optional | A | — |
| `dataUrlReadMax` | optional | A | — |
| `dataUrlReadMax.get` | optional | A | — |
| `dataUrlReadMax.set` | optional | A | — |
| `readFileText` | required | W | 512 |
| `readPluginSource` | optional | A | — |
| `selectPaths` | required | W | 509 |
| `selectSavePath` | optional | A | — |
| `writeClipboard` | required | W | 496 |
| `readClipboard` | required | W | 505 |
| `saveGatewayFile` | optional | A | — |
| `saveImageFromUrl` | required | W | 517 |
| `contextMenuEdit` | optional | A | — |
| `contextMenuCopyImage` | optional | A | — |
| `contextMenuSpellcheck` | optional | A | — |
| `contextMenuGuestAddWord` | optional | A | — |
| `onContextMenuSpellcheck` | optional | A | — |
| `saveImageBuffer` | required | W | 513 |
| `capturePreview` | optional | A | — |
| `savePastedText` | required | W | 515 |
| `saveClipboardImage` | required | W | 516 |
| `getPathForFile` | required | W | 510 |
| `normalizePreviewTarget` | required | W | 527 |
| `watchPreviewFile` | required | S | 558 |
| `watchDirectory` | optional | A | — |
| `stopPreviewFileWatch` | required | S | 559 |
| `setActiveWork` | optional | A | — |
| `setTitleBarTheme` | optional | A | — |
| `setNativeTheme` | optional | A | — |
| `glassSupported` | optional | S | 288 |
| `translucencySupported` | optional | S | 289 |
| `localModelsEnabled` | optional | S | 290 |
| `guestOnboardingEnabled` | optional | S | 291 |
| `skipIntro` | optional | S | 292 |
| `setTranslucency` | optional | A | — |
| `setKeepAwake` | optional | A | — |
| `minimizeToTray` | optional | A | — |
| `minimizeToTray.get` | optional | A | — |
| `minimizeToTray.set` | optional | A | — |
| `minimizeToTray.onChanged` | optional | A | — |
| `setDisableF12` | optional | A | — |
| `setF12ShortcutActive` | optional | A | — |
| `onF12Shortcut` | optional | A | — |
| `setPreviewShortcutActive` | optional | A | — |
| `openExternal` | required | W | 506 |
| `mcpOauth` | optional | A | — |
| `mcpOauth.listen` | optional | A | — |
| `mcpOauth.wait` | optional | A | — |
| `mcpOauth.cancel` | optional | A | — |
| `openPreviewInBrowser` | optional | A | — |
| `fetchLinkTitle` | required | S | 561 |
| `resolveFavicon` | optional | A | — |
| `sanitizeWorkspaceCwd` | required | S | 562 |
| `settings` | required | S | 563 |
| `settings.getDefaultProjectDir` | required | S | 564 |
| `settings.pickDefaultProjectDir` | required | S | 565 |
| `settings.setDefaultProjectDir` | required | S | 566 |
| `zoom` | optional | A | — |
| `zoom.get` | optional | A | — |
| `zoom.factor` | optional | A | — |
| `zoom.setPercent` | optional | A | — |
| `zoom.onChanged` | optional | A | — |
| `revealLogs` | required | S | 568 |
| `getRecentLogs` | required | W | 569 |
| `reportRendererError` | optional | A | — |
| `readDir` | required | S | 570 |
| `gitRoot` | optional | A | — |
| `revealPath` | optional | A | — |
| `openDir` | optional | A | — |
| `desktopPluginsRoot` | optional | A | — |
| `logsRoot` | optional | A | — |
| `reconcileDesktopPlugins` | optional | A | — |
| `renamePath` | optional | A | — |
| `writeTextFile` | optional | A | — |
| `trashPath` | optional | A | — |
| `git` | optional | A | — |
| `git.worktreeList` | optional | A | — |
| `git.worktreeAdd` | optional | A | — |
| `git.worktreeRemove` | optional | A | — |
| `git.branchSwitch` | optional | A | — |
| `git.branchList` | optional | A | — |
| `git.baseBranchList` | optional | A | — |
| `git.repoStatus` | optional | A | — |
| `git.fileDiff` | optional | A | — |
| `git.review` | optional | A | — |
| `git.review.list` | optional | A | — |
| `git.review.diff` | optional | A | — |
| `git.review.stage` | optional | A | — |
| `git.review.unstage` | optional | A | — |
| `git.review.revert` | optional | A | — |
| `git.review.revParse` | optional | A | — |
| `git.review.commit` | optional | A | — |
| `git.review.commitContext` | optional | A | — |
| `git.review.push` | optional | A | — |
| `git.review.shipInfo` | optional | A | — |
| `git.review.prList` | optional | A | — |
| `git.review.createPr` | optional | A | — |
| `git.scanRepos` | optional | A | — |
| `terminal` | required | S | 571 |
| `terminal.attach` | required | S | 572 |
| `terminal.cwd` | required | S | 573 |
| `terminal.dispose` | required | S | 574 |
| `terminal.onData` | required | S | 575 |
| `terminal.onExit` | required | S | 576 |
| `terminal.resize` | required | S | 577 |
| `terminal.start` | required | S | 578 |
| `terminal.write` | required | S | 579 |
| `reachPreviewUrl` | optional | A | — |
| `setActiveConnectionRoute` | optional | A | — |
| `onClosePreviewRequested` | optional | A | — |
| `onPreviewNav` | optional | A | — |
| `onOpenFolderRequested` | optional | A | — |
| `onOpenUpdatesRequested` | optional | A | — |
| `onDeepLink` | optional | A | — |
| `signalDeepLinkReady` | optional | A | — |
| `probePluginRepo` | optional | A | — |
| `installDesktopPlugin` | optional | A | — |
| `removeDesktopPlugin` | optional | A | — |
| `onWindowStateChanged` | optional | A | — |
| `onFocusSession` | optional | A | — |
| `onNotificationAction` | optional | A | — |
| `onNotificationActivate` | optional | A | — |
| `onPreviewFileChanged` | required | S | 560 |
| `onBackendExit` | required | S | 455 |
| `onPoolBackendRetiring` | optional | A | — |
| `onConnectionApplied` | optional | A | — |
| `onPowerResume` | optional | A | — |
| `getOnBattery` | optional | A | — |
| `onBatteryChanged` | optional | A | — |
| `onBootProgress` | required | S | 438 |
| `getBootstrapState` | required | S | 439 |
| `continueBootstrapLocal` | required | S | 450 |
| `recycleBackend` | optional | A | — |
| `resetBootstrap` | required | S | 451 |
| `repairBootstrap` | required | S | 452 |
| `cancelBootstrap` | required | S | 453 |
| `onBootstrapEvent` | required | S | 454 |
| `getVersion` | required | S | 456 |
| `getMachineProfile` | optional | A | — |
| `relaunchApp` | optional | A | — |
| `getRemoteDisplayReason` | optional | A | — |
| `updates` | required | S | 463 |
| `updates.check` | required | S | 464 |
| `updates.apply` | required | S | 465 |
| `updates.getBranch` | required | S | 466 |
| `updates.setBranch` | required | S | 467 |
| `updates.onProgress` | required | S | 468 |
| `uninstall` | required | S | 470 |
| `uninstall.summary` | required | S | 471 |
| `uninstall.run` | required | S | 481 |
| `themes` | required | S | 581 |
| `themes.fetchMarketplace` | required | S | 582 |
| `themes.searchMarketplace` | required | S | 583 |
| `findInPage` | required | S | 585 |
| `stopFindInPage` | required | S | 586 |
| `onFoundInPage` | required | S | 587 |
| `onOpenFindBarRequested` | required | S | 588 |

## Verdict: REJECTED
