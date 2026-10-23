# Hermes Android phase 1 review — astra

Reviewed HEAD `bfbd5b9` on 2026-10-22 against `run/briefs/review-panel.md`. No code changes or push. The admitted missing native project/APK/toolchain, unencrypted storage, memory-only attachments, unavailable local/cloud/SSH modes, and full-suite failures are not counted as findings.

## Findings

### 1. P1 — Registry edits forward the previous gateway's secret to a different host

**Location:** `app/src/platform/bridge.ts:383–385`; caller: `app/src/app/settings/connections-registry.tsx:431–474`.

The visible registry editor omits `payload.token` when its token box is blank. `connections.save` unconditionally inherits `current.token`, even when `input.url` changes host. The next REST request or connection test sends gateway A's secret to gateway B. This is different from `coerce`, which retains a token only for the same normalized base URL. A user editing an endpoint can disclose credentials to the new server without entering them there.

**Executed reproduction:** save `{httpUrl:'https://a.example', token:'A-secret'}`, then call `connections.save({id:'gateway',kind:'remote',label:'B',url:'https://b.example'})`. Persisted result was `{name:'B',httpUrl:'https://b.example',token:'A-secret'}`. No real credentials or external servers were used.

**Change needed:** share the same URL-bound token inheritance rule across both save paths; require an explicit new credential when the endpoint changes.

### 2. P1 — Registry save changes REST destination without retiring existing gateway sockets

**Location:** `app/src/platform/bridge.ts:378–388`, `:320–324`; lifecycle consumer: `app/src/app/gateway/hooks/use-gateway-boot.ts:1139`.

The registry editor is mounted by Gateway settings (`gateway-settings.tsx:1772`). Its save action only publishes the returned registry; `setConnectionsRegistry` only updates an atom. Unlike `applyConnectionConfig`, this bridge path neither reloads nor emits a connection-change event (the optional subscription is absent). Existing primary/secondary WebSockets retain their old endpoint, while every subsequent `bridge.api` reads the newly saved gateway. Editing A to B therefore leaves REST and live RPC/events targeting different servers until a reconnect/reload. Reusing the fixed connection ID also leaves cached session ownership associated with the old server.

**Change needed:** route material registry edits through the tested apply/reload flow, or reject endpoint/auth edits through this secondary UI. A label-only edit need not reload. This is a code-path finding, not a reproduced live two-server session.

### 3. P2 — HTTP timeout ends at headers, allowing a stalled body to hang indefinitely

**Location:** `app/src/platform/api-transport.ts:54–74`.

`fetch` resolves when response headers arrive. The `finally` clears the abort timer before `res.text()`, so a server that sends headers and stalls the body bypasses both the configured timeout and transport retry classification. This affects status probes, onboarding/apply, session requests and uploads waiting for replies. The existing timeout test only covers a fetch that never returns headers.

**Executed reproduction:** an immediately resolved response with a body delayed 150 ms succeeded after 152 ms with `timeoutMs:20`; the abort signal never fired. The probe used the transpiled production function and a response mock. A body that never settles would leave the promise pending.

**Change needed:** keep the timeout and error mapping around body consumption as well as `fetch`; retain the no-POST-retry rule.

### 4. P2 — URL previews advertise support but still require Electron's webview

**Location:** `app/src/platform/bridge.ts:513–514`; unchanged consumer: `app/src/app/chat/right-rail/preview-pane.tsx:1044–1048`.

`normalizePreviewTarget` accepts HTTP(S) URLs as supported URL previews. The renderer then creates `document.createElement('webview')`, sets Electron-only attributes, and waits for Electron guest events. Capacitor's Android WebView and ordinary browsers do not implement Electron's `<webview>` element, so this path produces an inert preview rather than a working browser. The remote-HTML iframe path is separate and does not fix ordinary URL tabs. This contradicts the root README's claim that the renderer never touches Electron directly and is not among the admitted local-file/pop-out limitations.

**Change needed:** explicitly make URL browser previews unavailable and direct users to an external browser, or implement a browser-compatible preview path with suitable isolation. Update the bridge fidelity table accordingly. No device runtime was available; this finding follows the actual element creation path.

### 5. P2 — Applying a changed gateway without a replacement token can report success and break boot

**Location:** `app/src/platform/bridge.ts:174–184`, `:335–347`; `app/src/app/settings/gateway-settings.tsx:585–595`.

`testGateway` skips the guarded REST route and WebSocket test when no token exists, but returns `ok:true`. `applyConnectionConfig` accepts that result and persists/reloads. `requireGateway` then refuses the same configuration. This is reachable when a previously configured user changes the URL and leaves the token blank: `canUseRemote` still sees the old `remoteTokenSet`, while `coerce` correctly drops the token for the new URL.

**Executed reproduction:** applying a remote URL with no saved token fetched only `/api/status`, succeeded and persisted; `getConnection()` immediately rejected with “no session token is saved.” The status response was mocked. Fresh onboarding normally disables save with no token, but the bridge does not enforce its own connection invariant.

**Change needed:** require a nonempty token before apply can save/reload. A public reachability probe may remain permissive but must not certify a usable connection.

### 6. P2 — Mixed-content configuration alone does not enable the promised plain-HTTP Android gateway

**Location:** `app/capacitor.config.ts:7–12`; `app/README.md` plain-HTTP/build instructions.

`android.allowMixedContent` changes WebView mixed-content policy only. The installed Capacitor code sets `MIXED_CONTENT_ALWAYS_ALLOW` in `Bridge.java:595`; the Android template manifest has no cleartext opt-in. The CLI's `dist/cordova.js:756–758` emits `usesCleartextTraffic` based on `server.cleartext`, which this config does not set. Android defaults cleartext traffic off for modern target SDKs, independently of mixed-content policy. Following the documented add/sync flow therefore does not establish HTTP support. This is a configuration omission beyond the explicitly admitted absence of `android/`, not a claim that an APK was tested. See [Android manifest documentation](https://developer.android.google.cn/guide/topics/manifest/application-element?hl=en) and [Capacitor configuration](https://next.capacitorjs.com/docs/next/config).

**Change needed:** choose HTTPS-only and say so, or configure a deliberate Android cleartext policy when generating the native shell, then verify HTTP REST and WS on device. Do not assume the desktop-browser smoke tests this policy.

## Bridge contract and README audit

The TypeScript AST inventory below covers every top-level contract member and every child of implemented object namespaces. An absent namespace means all its descendants are absent too (including imported `ScreenshotApi`/`HudModifierApi` contracts). All required top-level members and required children of implemented namespaces are present; the bridge is explicitly typed as `Window['hermesDesktop']`, and typecheck passes. Presence is not proof of behavioral fidelity.

Classification uses **full-fidelity** only for behavior matching the supported single-gateway remote scope, **web-equivalent** for an actual browser/local-storage implementation with limitations, **stubbed** for fixed/no-op/unavailable behavior, and **absent** for omitted optional capabilities. Object containers are marked “namespace” and their children carry the classification.

README corrections:

- HTTP token authentication is `X-Hermes-Session-Token`, not the claimed `Authorization: Bearer`; this matches Electron's session-token branch. The implementation/test agree; the prose is wrong.
- “Full fidelity” overstates `api` (body timeout), connection apply/testing and registry save (findings above), profile persistence (no backend relaunch/default-change events), and `connections.setPrimary` (no-op success).
- `profile.onDefaultChanged` is implemented as a no-op but omitted from the README stub list.
- The absent list omits `setDisableF12`, `setF12ShortcutActive`, `onF12Shortcut`, and `connections.setLaunchMode`, `.setLastUsed`, `.updateManaged`, `.updateAll`, `.onChanged`.
- `getVersion` actually returns truthful package/platform metadata; labeling it stubbed is unnecessarily pessimistic. `settings.setDefaultProjectDir` echoes the requested directory without saving it, rather than always returning none/cancelled.
- Web-equivalent does not establish native support: `notify` uses the browser Notification constructor with no action/activation wiring; file downloads use a click with no completion/error confirmation; external opening and clipboard/media APIs still need WebView validation. `saveImageFromUrl` reports true once a click is dispatched, not once an image is saved. Cross-origin download behavior is not equivalent to Electron saving a file.
- Optional absence does not universally hide UI: URL preview is one concrete counterexample; stubbed required features can also leave visible controls that report unavailable. The blanket “UI hides itself” wording is too strong.

| Contract member | Classification |
|---|---|
| `getConnection` | web-equivalent |
| `getConnectionFor` | web-equivalent |
| `getGatewayWsUrlFor` | full-fidelity |
| `getAgentRoster` | absent |
| `getProfileRoutes` | full-fidelity |
| `revalidateConnection` | web-equivalent |
| `touchBackend` | stubbed |
| `getPoolLimits` | stubbed |
| `setPoolLimits` | stubbed |
| `getGatewayWsUrl` | full-fidelity |
| `openSessionWindow` | stubbed |
| `openSessionInTerminal` | stubbed |
| `openWindow` | stubbed |
| `openBrowserWindow` | stubbed |
| `onBrowserPopoutClosed` | stubbed |
| `claimAmbientCue` | stubbed |
| `windowControls` | namespace |
| `windowControls.custom` | stubbed |
| `windowControls.minimize` | stubbed |
| `windowControls.toggleMaximize` | stubbed |
| `windowControls.close` | stubbed |
| `wakeIndicator` | absent |
| `petOverlay` | namespace |
| `petOverlay.open` | stubbed |
| `petOverlay.close` | stubbed |
| `petOverlay.setBounds` | stubbed |
| `petOverlay.setIgnoreMouse` | stubbed |
| `petOverlay.setFocusable` | stubbed |
| `petOverlay.pushState` | stubbed |
| `petOverlay.control` | stubbed |
| `petOverlay.onState` | stubbed |
| `petOverlay.onControl` | stubbed |
| `introReveal` | absent |
| `chatOnboarding` | absent |
| `hud` | absent |
| `screenshot` | absent |
| `hudModifier` | absent |
| `quickEntry` | namespace |
| `quickEntry.getSettings` | stubbed |
| `quickEntry.setSettings` | stubbed |
| `quickEntry.submit` | stubbed |
| `quickEntry.dismiss` | stubbed |
| `quickEntry.pushState` | stubbed |
| `quickEntry.onState` | stubbed |
| `quickEntry.onSubmit` | stubbed |
| `quickEntry.onShown` | stubbed |
| `getBootProgress` | stubbed |
| `getConnectionConfig` | web-equivalent |
| `saveConnectionConfig` | web-equivalent |
| `applyConnectionConfig` | web-equivalent |
| `testConnectionConfig` | web-equivalent |
| `getSecretStorageEncryption` | stubbed |
| `setSecretStorageEncryption` | stubbed |
| `connections` | namespace |
| `connections.list` | web-equivalent |
| `connections.save` | web-equivalent |
| `connections.remove` | stubbed |
| `connections.setPrimary` | stubbed |
| `connections.setLaunchMode` | absent |
| `connections.setLastUsed` | absent |
| `connections.test` | web-equivalent |
| `connections.updateManaged` | absent |
| `connections.updateAll` | absent |
| `connections.onChanged` | absent |
| `sshConfigHosts` | stubbed |
| `sshResolveHost` | stubbed |
| `probeConnectionConfig` | web-equivalent |
| `oauthLoginConnectionConfig` | stubbed |
| `oauthLogoutConnectionConfig` | stubbed |
| `cloud` | namespace |
| `cloud.status` | stubbed |
| `cloud.login` | stubbed |
| `cloud.logout` | stubbed |
| `cloud.discover` | stubbed |
| `cloud.agentSignIn` | stubbed |
| `profile` | namespace |
| `profile.getDefault` | web-equivalent |
| `profile.setDefault` | web-equivalent |
| `profile.onDefaultChanged` | stubbed |
| `profile.get` | web-equivalent |
| `profile.remember` | web-equivalent |
| `profile.set` | web-equivalent |
| `api` | web-equivalent |
| `notify` | web-equivalent |
| `requestMicrophoneAccess` | web-equivalent |
| `readWindowBelow` | absent |
| `readFileDataUrl` | web-equivalent |
| `readFileDataUrlForAttach` | absent |
| `dataUrlReadMax` | absent |
| `readFileText` | web-equivalent |
| `readPluginSource` | absent |
| `selectPaths` | web-equivalent |
| `selectSavePath` | absent |
| `writeClipboard` | web-equivalent |
| `readClipboard` | web-equivalent |
| `saveGatewayFile` | absent |
| `saveImageFromUrl` | web-equivalent |
| `contextMenuEdit` | absent |
| `contextMenuCopyImage` | absent |
| `contextMenuSpellcheck` | absent |
| `contextMenuGuestAddWord` | absent |
| `onContextMenuSpellcheck` | absent |
| `saveImageBuffer` | web-equivalent |
| `capturePreview` | absent |
| `savePastedText` | web-equivalent |
| `saveClipboardImage` | web-equivalent |
| `getPathForFile` | web-equivalent |
| `normalizePreviewTarget` | web-equivalent |
| `watchPreviewFile` | stubbed |
| `watchDirectory` | absent |
| `stopPreviewFileWatch` | stubbed |
| `setActiveWork` | absent |
| `setTitleBarTheme` | absent |
| `setNativeTheme` | absent |
| `glassSupported` | stubbed |
| `translucencySupported` | stubbed |
| `localModelsEnabled` | stubbed |
| `guestOnboardingEnabled` | stubbed |
| `skipIntro` | stubbed |
| `setTranslucency` | absent |
| `setKeepAwake` | absent |
| `minimizeToTray` | absent |
| `setDisableF12` | absent |
| `setF12ShortcutActive` | absent |
| `onF12Shortcut` | absent |
| `setPreviewShortcutActive` | absent |
| `openExternal` | web-equivalent |
| `mcpOauth` | absent |
| `openPreviewInBrowser` | absent |
| `fetchLinkTitle` | stubbed |
| `resolveFavicon` | absent |
| `sanitizeWorkspaceCwd` | stubbed |
| `settings` | namespace |
| `settings.getDefaultProjectDir` | stubbed |
| `settings.pickDefaultProjectDir` | stubbed |
| `settings.setDefaultProjectDir` | stubbed |
| `zoom` | absent |
| `revealLogs` | stubbed |
| `getRecentLogs` | web-equivalent |
| `reportRendererError` | absent |
| `readDir` | stubbed |
| `gitRoot` | absent |
| `revealPath` | absent |
| `openDir` | absent |
| `desktopPluginsRoot` | absent |
| `logsRoot` | absent |
| `reconcileDesktopPlugins` | absent |
| `renamePath` | absent |
| `writeTextFile` | absent |
| `trashPath` | absent |
| `git` | absent |
| `terminal` | namespace |
| `terminal.attach` | stubbed |
| `terminal.cwd` | stubbed |
| `terminal.dispose` | stubbed |
| `terminal.onData` | stubbed |
| `terminal.onExit` | stubbed |
| `terminal.resize` | stubbed |
| `terminal.start` | stubbed |
| `terminal.write` | stubbed |
| `reachPreviewUrl` | absent |
| `setActiveConnectionRoute` | absent |
| `onClosePreviewRequested` | absent |
| `onPreviewNav` | absent |
| `onOpenFolderRequested` | absent |
| `onOpenUpdatesRequested` | absent |
| `onDeepLink` | absent |
| `signalDeepLinkReady` | absent |
| `probePluginRepo` | absent |
| `installDesktopPlugin` | absent |
| `removeDesktopPlugin` | absent |
| `onWindowStateChanged` | absent |
| `onFocusSession` | absent |
| `onNotificationAction` | absent |
| `onNotificationActivate` | absent |
| `onPreviewFileChanged` | stubbed |
| `onBackendExit` | stubbed |
| `onPoolBackendRetiring` | absent |
| `onConnectionApplied` | absent |
| `onPowerResume` | absent |
| `getOnBattery` | absent |
| `onBatteryChanged` | absent |
| `onBootProgress` | stubbed |
| `getBootstrapState` | stubbed |
| `continueBootstrapLocal` | stubbed |
| `recycleBackend` | absent |
| `resetBootstrap` | stubbed |
| `repairBootstrap` | stubbed |
| `cancelBootstrap` | stubbed |
| `onBootstrapEvent` | stubbed |
| `getVersion` | web-equivalent |
| `getMachineProfile` | absent |
| `relaunchApp` | absent |
| `getRemoteDisplayReason` | absent |
| `updates` | namespace |
| `updates.check` | stubbed |
| `updates.apply` | stubbed |
| `updates.getBranch` | stubbed |
| `updates.setBranch` | stubbed |
| `updates.onProgress` | stubbed |
| `uninstall` | namespace |
| `uninstall.summary` | stubbed |
| `uninstall.run` | stubbed |
| `themes` | namespace |
| `themes.fetchMarketplace` | stubbed |
| `themes.searchMarketplace` | stubbed |
| `findInPage` | stubbed |
| `stopFindInPage` | stubbed |
| `onFoundInPage` | stubbed |
| `onOpenFindBarRequested` | stubbed |

## Renderer parity and boot order

`diff -rq upstream/apps/desktop/src app/src` returned only `Only in app/src: platform`. There are **no renderer modifications outside the adaptation directory**, including the contract, styles and copied tests. `diff -rq upstream/apps/shared app/shared` found only upstream package/config metadata absent; shared source is identical. This verifies parity against the vendored snapshot, not independently against the remote upstream release archive.

The entry installs the bridge before dynamically importing `main` or onboarding. Phone-layout's static imports are safe leaf modules: titlebar imports its connection type only, layout constants are constants, and pane-shell's index exports the event name. I found no early store evaluation introduced by these imports. Vite aliases correctly point `@hermes/shared` at the copied shared source, use relative build assets, and keep one React/React DOM resolution. Source parity does not imply runtime/device or pixel parity: Android lacks Electron guest tags, native chrome and platform fonts.

## Gateway transport assessment

- Normalization accepts HTTP(S), adds HTTP to an unqualified host, strips search/hash and trailing slashes; WS derivation retains host/port/path prefix, selects ws/wss, and URL-encodes the token. These rules match the vendored desktop helpers. Profile scope preserves an existing `profile` query value. Registry APIs intentionally ignore arbitrary route IDs and use the one gateway; stale/unknown IDs are not independently validated.
- Header-based session auth, JSON serialization, multipart field `file`, filename CR/LF/quote cleanup, status-code errors, empty responses and HTML/malformed-JSON detection are implemented. Multipart boundaries are left to the browser correctly. Redirects are not followed; opaque browser redirects get a useful error, though Electron's Location-specific diagnostics are unavailable.
- GET/HEAD/OPTIONS retry transport failure twice with bounded backoff; POST/PUT/PATCH/DELETE never retry. This is a sensible conservative browser adaptation of Electron's never-sent policy. HTTP 401/403/5xx do not get transport retries. Response-body timeout/error handling is the exception in finding 3.
- `api-transport.ts` is REST, **not** a replacement for `apps/shared/src/json-rpc-gateway.ts`. The latter and its channel remain byte-identical, preserving request correlation, WS connection/request timeouts, heartbeat, event sequencing, replay and pending-call teardown. The renderer still uses that shared client. Registry lifecycle integration is nevertheless broken as described above.
- Connection status alone is a public liveness check, not auth validation. A token-bearing apply additionally tests sessions and WS open. `probeWebSocket` validates open only, not `gateway.ready`/an RPC round trip; its error branch does not explicitly close the socket, and it has no `onclose` settlement before timeout. These are weaker checks than a complete chat transaction.
- Browser CORS/preflight and WebSocket Origin acceptance now matter where Electron main-process HTTP did not. The custom auth header requires gateway CORS support for the app origin (`https://localhost` by Capacitor default). No backend source is vendored to independently establish that every deployed gateway admits it; the desktop-browser smoke alone cannot establish the APK origin works.

## Security assessment

The admitted localStorage choice is a **medium production risk**, not a newly counted defect: ordinary other apps do not automatically gain access to app-private data, but same-origin script execution can read the bearer-equivalent session token, and backup/device-compromise policy is still unspecified. `secureTokenStorage:true` and `remoteTokenPlainText:false` suppress truthful UI warnings; the README acknowledges this, but those booleans do not provide encryption. The native template also enables backup; decide backup exclusions when the project is generated.

The concrete worse secret-handling issue is finding 1. Plain HTTP/WS additionally exposes tokens and conversation traffic to an on-path observer outside a trusted encrypted tunnel. `allowMixedContent:true` broadens what the WebView may load; it does not encrypt traffic or itself prove an XSS.

Reviewed the renderer's main raw-content surfaces: SVG embeds and artifact SVG use DOMPurify; Mermaid initializes strict security; generated HTML uses `sandbox="allow-scripts"` without same-origin permission; remote HTML uses an empty sandbox; the reusable SandboxedFrame allowlists schemes/tokens and forbids `allow-same-origin`. These are meaningful barriers against model/generated content reading localStorage. I did not establish a working XSS exploit. There is no CSP in `index.html`; treat defense-in-depth and `openExternal`/download URL validation as follow-up hardening rather than an invented demonstrated exploit. A broad dependency vulnerability audit was not performed.

## Phone layout and lifecycle

The CSS is correctly enclosed in `max-width:767.98px`; the pointer handler additionally requires the upstream collapse media query (below 640 px) and a mounted overlay. Thus the new rules do not change tablet layout at 768 px or above. The documented 640–767 px docked rails are accurate, although this means the overall phone category is not uniformly a drawer. Titlebar offset is 34/16 rem, consistent with the existing titlebar constant.

Outside taps close the drawer; titlebar controls and recognized portalled dialogs/menus are excluded. Navigation dismissal compares URL before pointerdown and after click. Same-URL selections, asynchronous navigation that occurs after the zero-delay callback, keyboard activation, and clicks whose propagation is stopped are not covered by that heuristic. No smoke assertion tests navigation dismissal, 639/640/767/768 boundaries, rotation, software keyboard or system insets.

**Low-priority leak:** each pointerdown inside the drawer installs a fresh once-only click listener on the target (`phone-layout.ts:58`). Touch scrolling/cancelled gestures may never produce that click, so repeated gestures on a retained target accumulate listeners and captured URL/overlay references until a later click or removal. A later click can fire multiple stale close attempts. Use a single delegated click handler, or cancel gesture listeners on pointer cancellation. The one document-level listener has page lifetime and is not itself a normal per-render leak: installation runs once. Reinstalling would duplicate style tags, though no production repeat-install path was found. Outside dismissal does not consume the event, so the underlying touched control can also activate; confirm that UX intentionally.

## Verification and upstream render-loop claim

Executed during this review:

| Check | Result |
|---|---|
| `npm run typecheck` | Pass, exit 0 |
| `npx vitest run src/platform` | Pass, 1 file / 10 tests |
| `npm run build` | Pass, exit 0; Vite reports 1m 34s |
| Full renderer/shared diffs | Results described above |
| TS AST contract inventory | No missing required bridge members |
| Isolated production-module probes | Cross-host token retention, tokenless apply and body-timeout failure reproduced |

The probes transpiled existing TypeScript in memory and used mock storage/network APIs; they changed no repository code. Build emitted ignored `dist` output. No APK/device test, live gateway smoke, full 1,012-file test suite or Electron comparison was rerun. Build warnings include advancedChunks deprecation; they did not fail the build.

The smoke script plausibly produces the README's reported output. It really drives onboarding, reloads, checks sidebar/composer at 1280, captures 820, creates a touch/mobile 390 context, dismisses the no-provider overlay, opens/closes the drawer and checks document overflow. It records page errors and fails on them. Onboarding and tablet attach two listeners to the same page, explaining duplicated error counts. Ordinary console errors such as 409 are logged but not independently fatal.

Limits: the 820 step is a resize/screenshot, not another explicit connected/layout assertion. Selector presence does not prove stable chat, sending a message, RPC completion or server-backed feature parity. No image comparison proves pixel parity. The smoke uses desktop Chromium, not Capacitor/Android permissions, downloads, networking or lifecycle.

The upstream-loop attribution is **plausible and supported by the recorded controlled comparison**, not independently reconfirmed here. Renderer source identity is verified; the README describes matching resolved assistant-ui versions and reproduction under upstream Electron/preload, which is much stronger than merely reproducing under the Android bridge. Its scratch node-pty/dependency/setup changes are disclosed. However the raw Electron trace/reproduction harness is not part of this review's executed evidence, so the exact getSnapshot diagnosis remains a reported result. Upstream reproduction would justify “not introduced by this port”; it does **not** establish that the app “works afterwards” across all features. Keeping smoke red is honest. Do not silently waive it as functional acceptance. The owner-backfill 409 path is shared upstream code; its documented live-server explanation was not independently rerun.

## Native APK readiness

`com.bunge.hermes` is a structurally valid application ID; app name and `webDir:'dist'` match build output. Capacitor core/android/CLI are consistently pinned to 8.5.3. `android:debug` correctly builds, syncs and invokes the project wrapper once `cap add android` has created it. The absence of that project/toolchain/APK is accurately documented and is not a rejection reason here.

Before a real APK is claimed, generate and inspect the native project's merged manifest and target SDK, resolve finding 6, verify actual gateway CORS/Origin behavior, media permissions and native notification/download behavior, handle Android back/background/reconnect and keyboard/inset behavior, and configure release signing plus backup/storage policy. Browser build success cannot substitute for these checks. These are readiness tasks, not extra findings for the expressly deferred native phase.

The port preserves source isolation well and its build claims hold, but the credential disclosure and split-server lifecycle defects require correction before accepting phase 1. Findings 3–6 also need fixes or explicitly reduced supported behavior.

## Verdict: REJECTED
