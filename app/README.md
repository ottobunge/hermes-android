# Hermes for Android

An Android (Capacitor) port of the **Hermes desktop app** — the Electron +
React renderer from `upstream/apps/desktop` (v0.17.6, hermes-agent 0.21.5).

- **Tablet (≥ 768px): desktop parity.** The renderer in `src/` is a
  byte-identical copy of upstream (`diff -rq` differs only by `src/platform/`);
  it runs unchanged.
- **Phone (< 768px): minimal adaptations** of the same layout, through one
  small adaptation layer (`src/platform/phone-layout.ts`) — not a forked
  component tree. Upstream already turns the side rails into a drawer below
  640px (titlebar toggle → overlay, full-width transcript, docked composer);
  the phone layer fixes what breaks on a touch phone: the drawer sits below
  its toggle, it closes on a tap outside or when a tap inside navigates, the
  "HERMES AGENT" wordmark shrinks instead of clipping, the statusbar
  scrolls sideways, overlay views (Settings, Scheduled jobs, …) drop their
  ~44px side gutters, and the connection-mode cards size to their content so
  the gateway URL field is on the first screen. All of it is gated on
  `max-width: 767.98px`; the smoke checks at 820px that it doesn't leak.
- **Remote gateway only.** Android cannot spawn the local Python agent, so the
  app is a client for a Hermes gateway running elsewhere (`hermes serve`),
  using the desktop's existing remote-connection mode.

`../upstream/` is the pristine upstream reference — never edit it. Re-vendor
it and 3-way diff against `app/src` to pick up upstream changes. Everything
Android-specific lives in `src/platform/` (each file is headed
"Android adaptation layer"), plus `index.html` → `src/platform/entry.ts`,
`vite.config.ts` (including an alias that resolves the vendored stylesheet's
monorepo-relative `../../../node_modules/…` font URLs from `app/node_modules`),
`vitest.config.ts`, `capacitor.config.ts`. One dependency is patched on
purpose: `patches/@assistant-ui+core+0.2.23.patch`, applied by
`patch-package` on `postinstall`. It fixes the upstream render loop; see
"Fixed: assistant-ui thread-list render loop" below.

## How it works

The renderer's entire native surface is one object, `window.hermesDesktop`
(contract: `src/global.d.ts`; Electron's version: `electron/preload.ts`).
`src/platform/bridge.ts` implements it with fetch/WebSocket/web APIs and
`src/platform/entry.ts` installs it before any renderer module evaluates.

- A single saved gateway `{ name, httpUrl, token }` lives in localStorage
  (`src/platform/gateway-config.ts`). Every route/profile resolves to it —
  Electron's v1 "global remote" mode.
- **The page is pinned to the gateway it booted with.** REST (`api`) and the
  WebSocket descriptor both come from that one booted gateway. A saved change
  takes effect only through a reload, so the two transports can never point
  at different servers.
- **One edit rule for every save path** (`resolveGatewayEdit`, used by
  Settings → Gateway and the connections registry): leaving the token blank
  keeps the saved token **only for the same normalized endpoint**. A new
  endpoint needs its own token, and an edit that ends without a token is
  refused.
- **There are two ways a change takes effect.**
  - Applying a new endpoint or token tests it first (`/api/status` → authed
    `/api/sessions` → `/api/ws` open), then saves, then reloads.
    Reachability alone never counts as success. Both Settings → Gateway "Save
    and reconnect" and a registry edit that changes the endpoint or token
    take this path.
  - Settings → Gateway "Save for next restart" only persists. It does no
    test, and the running page stays on its booted gateway until the next
    launch.
  - A label-only registry edit is saved in place.
  - A registry row's **Test** checks the **saved** gateway the row shows,
    which may differ from the booted one.
- No saved gateway → onboarding (`src/platform/onboarding.tsx`), which mounts
  the desktop's own **Settings → Gateway** panel.
- `api(request)` (`src/platform/api-transport.ts`) mirrors Electron's REST
  helper:
  - `X-Hermes-Session-Token` auth (Electron's token mode);
  - multipart upload and the same `"<status>: <body>"` errors;
  - **one timeout covering headers and body**, so a stalled body times out
    too;
  - GET/HEAD/OPTIONS retry transport failures, mutating verbs never retry.
- **Use an HTTPS/WSS gateway.** See "Deviations" for plain HTTP.

## Bridge status

Every member of `window.hermesDesktop`. All non-optional members are present
(checked against `src/global.d.ts`), so no `hermesDesktop.* is not a function`
is possible from a missing required member. "Full fidelity" means the same
behavior as Electron **within the supported single token-gateway scope**,
not Electron's lifecycle in general. "Web equivalent" depends on browser and
WebView capabilities and has not been verified on an Android device.

### Full fidelity (single gateway)

- `getGatewayWsUrl` / `getGatewayWsUrlFor` — `ws(s)://…/api/ws?token=…` from the booted gateway (session token, or the sign-in's access token, refreshed first if it is about to expire)
- `getProfileRoutes` — every profile routes to the one gateway
- `probeConnectionConfig` — public `/api/status`; on a gated gateway (`auth_required`) also the public `/api/auth/providers` list → `authMode: 'oauth'` + providers (`supportsPassword` drives the panel's "Sign in" copy)
- `oauthLoginConnectionConfig` — gated-gateway sign-in via the gateway's native RFC 8252 flow (PKCE S256 + state, `/auth/native/authorize` → the gateway's own login page → loopback callback intercepted by `MainActivity` → `/auth/native/token`). The page navigates away, so the promise never settles; the sign-in completes on the next page load (round 16)
- `oauthLogoutConnectionConfig` — clears the sign-in locally (stored and running) and tells the gateway `/auth/logout` best-effort with Bearer; see "Gated gateways" for the revocation limit

### Web equivalent

- `getConnection` / `getConnectionFor` — `/api/status` probe → `HermesConnection` (mode `remote`, token, wsUrl)
- `revalidateConnection` — re-probes `/api/status`
- `api` — fetch with session-token auth (or Bearer + one refresh-and-retry on a gated gateway), whole-exchange timeout, multipart upload
- `getConnectionConfig` / `saveConnectionConfig` / `applyConnectionConfig` / `testConnectionConfig` — drive the reused Gateway settings panel (remote only; token mode or a gated gateway's sign-in; save persists for the next boot — an OAuth save before signing in is a no-op; apply = test → save → reload; test without a usable token or sign-in fails)
- `connections.list` / `.save` / `.test` — a one-entry registry; `.save` changes to endpoint or token go through test → save → reload, label-only edits save in place
- `profile.get` / `.set` / `.remember` / `.getDefault` / `.setDefault` — localStorage (no backend relaunch)
- `getVersion` — real app version, `platform: 'android'`
- `notify` — Web `Notification` (asks permission on first use; no action/activation wiring)
- `requestMicrophoneAccess` — `getUserMedia({ audio: true })`
- `writeClipboard` / `readClipboard` — `navigator.clipboard`
- `saveClipboardImage` — `navigator.clipboard.read()` image → in-memory file
- `openExternal` — `window.open(url, '_blank')`
- `selectPaths` — `<input type=file>`; files are held in memory under synthetic `/android-local/…` paths
- `getPathForFile` / `readFileDataUrl` / `readFileText` — register / read those in-memory files
- `saveImageBuffer` / `savePastedText` — in-memory files
- `saveImageFromUrl` — `<a download>`; returns `true` once the click is dispatched, not once the file is saved
- `getRecentLogs` — the last 80 lines of the bridge's own 200-line log (only revalidation failures write to it)

### Stubbed (present, returns the safest "unavailable"/empty value)

- Flags: `glassSupported`, `translucencySupported`, `localModelsEnabled`, `guestOnboardingEnabled` = `false`; `skipIntro` = `true`
- `touchBackend` → `{ ok: true }` (no local backend to keep warm)
- `getPoolLimits` / `setPoolLimits` → upstream defaults, not persisted
- `getSecretStorageEncryption` → off; `setSecretStorageEncryption` rejects
- `sshConfigHosts` / `sshResolveHost` → empty
- `connections.remove` rejects (exactly one gateway); `connections.setPrimary` → success-shaped no-op
- `profile.onDefaultChanged` → no-op subscription
- `normalizePreviewTarget` → always `null` (no native preview classification; see "Web previews" in Deviations)
- `cloud.status` / `.logout` → signed out; `cloud.login` / `.discover` / `.agentSignIn` reject
- Boot/bootstrap: `getBootProgress` → ready 100%; `getBootstrapState` → inactive; `continueBootstrapLocal` / `resetBootstrap` / `repairBootstrap` / `cancelBootstrap` → ok; `onBootProgress` / `onBootstrapEvent` / `onBackendExit` → no-op subscriptions
- `updates.*` → unsupported ("update from the store"); `uninstall.*` → unsupported
- `claimAmbientCue` → `true`
- Windows: `openSessionWindow` / `openSessionInTerminal` / `openWindow` / `openBrowserWindow` → `{ ok: false }`; `onBrowserPopoutClosed` no-op; `windowControls` no-ops (`custom: false`)
- `petOverlay.*`, `quickEntry.*` → disabled / no-ops
- `watchPreviewFile` rejects; `stopPreviewFileWatch` → `true`; `onPreviewFileChanged` no-op
- `fetchLinkTitle` → `''`; `sanitizeWorkspaceCwd` → passthrough
- `settings.getDefaultProjectDir` → none; `.pickDefaultProjectDir` → cancelled; `.setDefaultProjectDir` echoes the request without saving it
- `revealLogs` / `readDir` → unsupported
- `terminal.*` → unavailable (`start` rejects)
- `themes.fetchMarketplace` rejects; `themes.searchMarketplace` → `[]`
- `findInPage` → 0 results; `stopFindInPage` / `onFoundInPage` / `onOpenFindBarRequested` no-ops

### Absent (optional members)

The renderer feature-detects these. Most of the UI that depends on them hides
itself, but not all of it: some callers fall back or show an "unavailable"
state.

- Agents/HUD: `getAgentRoster`, `wakeIndicator`, `introReveal`, `chatOnboarding`, `hud`, `hudModifier`, `screenshot`, `readWindowBelow`
- Files: `readFileDataUrlForAttach`, `dataUrlReadMax`, `readPluginSource`, `selectSavePath`, `saveGatewayFile`, `capturePreview`, `watchDirectory`, `renamePath`, `writeTextFile`, `trashPath`, `revealPath`, `openDir`, `gitRoot`, `git`
- Context menu: `contextMenuEdit`, `contextMenuCopyImage`, `contextMenuSpellcheck`, `contextMenuGuestAddWord`, `onContextMenuSpellcheck`
- Window/OS: `setActiveWork`, `setTitleBarTheme`, `setNativeTheme`, `setTranslucency`, `setKeepAwake`, `minimizeToTray`, `setDisableF12`, `setF12ShortcutActive`, `onF12Shortcut`, `setPreviewShortcutActive`, `zoom`, `relaunchApp`, `getMachineProfile`, `getOnBattery`, `onBatteryChanged`, `onPowerResume`, `onWindowStateChanged`
- Preview: `openPreviewInBrowser`, `reachPreviewUrl`, `resolveFavicon`, `onClosePreviewRequested`, `onPreviewNav`
- Plugins: `desktopPluginsRoot`, `reconcileDesktopPlugins`, `probePluginRepo`, `installDesktopPlugin`, `removeDesktopPlugin`
- Connection/backend: `connections.setLaunchMode`, `.setLastUsed`, `.updateManaged`, `.updateAll`, `.onChanged`, `setActiveConnectionRoute`, `onConnectionApplied`, `onPoolBackendRetiring`, `recycleBackend`, `getRemoteDisplayReason`, `mcpOauth`
- Events/misc: `onOpenFolderRequested`, `onOpenUpdatesRequested`, `onDeepLink`, `signalDeepLinkReady`, `onFocusSession`, `onNotificationAction`, `onNotificationActivate`, `reportRendererError`, `logsRoot`

## Deviations and known limitations

- **No local backend.** Remote gateway only. The reused Gateway panel still
  shows the desktop's Local / Hermes Cloud / SSH mode cards; choosing any of
  them errors ("Android connects to a remote Hermes gateway only").
- **Gated gateways (round 16).** A `hermes serve` with dashboard auth
  (`dashboard.basic_auth` or OAuth providers) is signed into with the
  gateway's native RFC 8252 flow. REST then carries `Authorization: Bearer`,
  the WebSocket `?token=<access>`, and a 401 rotates the tokens once via
  `/auth/native/refresh`. Limits:
  - **Logout can't revoke server-side.** `/auth/logout` only revokes cookie
    sessions. Signing out clears the tokens on the device, but the refresh
    token stays valid on the gateway until it expires (30 days for basic
    auth).
  - **Some upstream IdPs refuse embedded WebViews** (Google notably). The
    sign-in runs inside the app's WebView, so such a provider's own login
    page may block it. Password providers and IdPs that allow WebViews work.
  - **The loopback callback is completed by the Android shell**
    (`MainActivity`). In a desktop browser (`npm run dev` / `preview`) the
    final `http://127.0.0.1/?code=…` has nothing to catch it, so the sign-in
    doesn't complete there. `scripts/gated-signin-e2e.mjs` stands in for the
    shell with a request route.
  - Hermes Cloud sign-in is still unavailable.
- **One gateway.** No multi-connection registry. Changing the gateway reloads
  the page instead of Electron's in-place re-dial, and the running page stays
  on the gateway it booted with until then.
- **Token storage** is the WebView's localStorage (app-private sandbox), not
  Android Keystore-encrypted, though `secureTokenStorage` reports `true`.
- **Attachments are in-memory** (`src/platform/local-files.ts`) and lost on reload.
- **No terminal, git, file browser, local file previews, pop-out windows, pet
  overlay, quick entry, find-in-page, in-app updates.**
- **HTTPS/WSS gateways are the supported path.** Plain `http://` sends the
  session token, a gated gateway's password and access/refresh tokens, and all
  traffic unencrypted, so use it only on a network you trust (LAN/tailnet). The onboarding copy says so. On a native Android build it
  will also need an explicit cleartext policy (`server.cleartext` or a
  `networkSecurityConfig`). `allowMixedContent` does **not** provide that, so
  it was removed from `capacitor.config.ts`. *(Since `android/` was
  generated, `capacitor.config.ts` sets a **debug test-rig** policy:
  `server.cleartext: true` + `androidScheme: 'http'`, commit `9a7843e`, which
  says a release build must not ship it. The release policy is still open.)*
- **Web previews are unavailable.** The desktop's Browser/URL preview pane
  hosts pages in Electron's `<webview>` guest tag, which Android's WebView
  doesn't have. `src/platform/webview-unavailable.ts` makes that tag fail
  through the pane's own load-error path: "In-app web previews are not
  available on Android", with the URL as a link that opens the system browser
  (`openExternal`). The bridge advertises no preview targets
  (`normalizePreviewTarget` → `null`). Remote HTML artifacts render in their
  sandboxed iframe and are unaffected.
- **Phone layout covers presentation only.** Between 640 and 767px the rails
  stay docked (upstream's collapse breakpoint is 640px, not 768px). Below
  640px the drawer has no swipe gesture: open and close it with the titlebar
  toggle or a tap outside. No bottom nav. Overlay views stay overlays (cards
  over the app with a titlebar-height top inset), not full-screen routes.
- **Fixed: assistant-ui thread-list render loop (deliberate divergence from
  upstream).** Upstream, every connected page threw several uncaught
  `Maximum update depth exceeded. The result of getSnapshot should be
  cached…` errors. Typing added `… a resource repeatedly calls setState
  inside useEffect.` errors, and the loop could knock the main workspace
  pane into its "failed to render" error boundary, during session switches
  or typing. All of it reproduced in the unmodified upstream Electron app.
  The port carries a one-line `patch-package` fix to `@assistant-ui/core`,
  and the smoke now tolerates **no** page errors. Root cause, fix and
  evidence are under "Verification → Render-loop fix".
- **`app/android/` does not exist.** `npx cap add android` / `npx cap sync
  android` were not run, so the native project is not committed yet.
- **No Android SDK/JDK on this machine** (`java`, `sdkmanager`, `adb` absent,
  `ANDROID_HOME` unset). `gradlew assembleDebug` was **NOT** run; no APK has
  been built.
- **Vitest:** the Electron main-process project is dropped (nothing to run it
  against). The full UI suite does not pass here — see "Verification" below.

## Develop / build

Requires Node 22+.

```sh
cd app
npm install                # postinstall: patch-package applies patches/
npm run typecheck          # tsc -p . --noEmit
npm test                   # vitest run (full suite is slow: ~1000 files)
npx vitest run src/platform  # bridge checks + the assistant-ui patch check
node --test scripts/smoke-classifier.test.mjs  # smoke page-error classifier
npm run build              # vite build → dist/
npm run dev                # http://127.0.0.1:5174 (browser dev against a gateway)
npm run preview            # serves dist/ on http://127.0.0.1:4174
```

Android (needs JDK 21 + Android SDK with `ANDROID_HOME` set, none present here):

```sh
npx cap add android        # first time only; then commit app/android/
npm run android:debug      # build → cap sync android → ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

### Boot smoke

`scripts/smoke.mjs` serves nothing itself: run `npm run preview` and a gateway,
then

```sh
node scripts/smoke.mjs --app http://127.0.0.1:4174 --gateway http://127.0.0.1:19719 \
  --token <token> --chromium /path/to/chromium --out smoke-out
```

A scratch gateway that doesn't touch an existing one:

```sh
export HERMES_HOME=$(mktemp -d) HERMES_DASHBOARD_SESSION_TOKEN=$(openssl rand -hex 24)
hermes serve --port 19719 --skip-build &   # REST + /api/ws
hermes gateway run &                       # initializes state.db (else /api/sessions → 503)
# the two sessions the smoke switches between (synthetic transcripts)
for f in scripts/smoke-sessions/alpha.jsonl scripts/smoke-sessions/beta.jsonl; do
  hermes sessions import --from claude "$f"
done
hermes sessions list                       # then rename the two imported ids:
hermes sessions rename <alpha-id> "Smoke alpha"
hermes sessions rename <beta-id>  "Smoke beta"
# the project the phone drawer-browsing check drills into (round 11)
mkdir -p /tmp/smoke-project && hermes project create "Smoke project" /tmp/smoke-project
```

Run `npm run build` before every smoke: a stale `dist/` serves a blank page
(round 9).

## Verification

### Round 16 (2026-10-23): gated-gateway sign-in (basic_auth / OAuth)

A gateway with dashboard auth runs **gated** (`auth_required`). It ignores
the static session token, so before this round every authed call 401'd and the
WS upgrade 403'd, and "Sign in" failed with "Not available on Android".

**Protocol, checked against the installed gateway source**
(`hermes_cli/dashboard_auth/routes.py`):
- `/auth/native/authorize` requires S256 and a canonical **loopback**
  `redirect_uri` (IP literal; `localhost` is rejected). We use
  `http://127.0.0.1/`.
- `/auth/native/token` and `/auth/native/refresh` return the tokens in JSON,
  with no cookies. Refresh rejection is `401 {"error":"session_expired"}`.
- `/auth/logout` revokes **only cookie sessions**, so a Bearer client can't
  revoke its refresh token (see Deviations).
- `/auth/password-login` (cookies only) is not used.

**Web side** (`src/platform/`):
- `oauth.ts` (new): PKCE with WebCrypto (32-byte verifier, `b64url(SHA-256)`
  challenge), random state, and the pending sign-in in
  `hermes.android.oauth-pending`.
  - `startOauthLogin` navigates the whole page to the authorize URL.
  - `completeOauthRedirect`, run by `entry.ts` **before** choosing onboarding
    or the app, redeems `?oauth-code=&oauth-state=` with the verifier. It
    stores `{authMode:'oauth', token, refreshToken, tokenExpiresAt}` and
    cleans the URL. A state mismatch, missing pending, bogus code or expired
    pending (30 min) stores **nothing** and leaves a one-shot notice
    (inline on onboarding, a notification in the app). A pending sign-in
    with no code is a **cancellation** (Back out of the login page).
  - `refreshOauthTokens` is single-flight per refresh token and rotates the
    tokens **in place**, so the booted gateway object picks them up. It only
    writes the stored copy if that copy holds the same credential.
    `session_expired` clears the tokens.
- `gateway-config.ts`: `SavedGateway` gains optional `authMode`,
  `refreshToken` and `tokenExpiresAt`. If they're absent the gateway is in
  token mode, so existing saved gateways are unchanged. A same-endpoint edit
  with no new token keeps the sign-in; a typed token means token mode.
- `api-transport.ts`: an OAuth gateway sends **only** `Authorization: Bearer`,
  any other gateway **only** `X-Hermes-Session-Token`. A 401 on an OAuth
  gateway refreshes once (shared by concurrent callers) and retries once; if
  another request already rotated the token, it just retries.
- `bridge.ts`:
  - probe lists providers;
  - `connectionConfig` reports `remoteOauthConnected`;
  - an OAuth save before sign-in is a no-op: the panel saves first, and a
    token-less gateway can't boot;
  - apply/test use the signed-in gateway;
  - `getConnection` / `getGatewayWsUrl*` refresh an access token within 60 s
    of expiry (the WS leg has no 401 retry);
  - login never settles (the page unloads; documented in `bridge.ts`);
  - logout clears locally and notifies the gateway best-effort.
- `onboarding.tsx`: the notice, plus copy that mentions sign-in and that
  `http://` sends credentials unencrypted.

**Native side** (`android/app/src/main/java/com/bunge/hermes/MainActivity.java`).
Capacitor's `launchIntent` sends every non-app host to the **system
browser**, which would leave the app mid-sign-in. `GatewaySignInClient`
(a `BridgeWebViewClient` subclass) handles this:
- From a main-frame navigation to `…/auth/native/authorize` until the app
  origin loads again, it keeps main-frame http(s) navigation in the WebView:
  the gateway's `/login`, a provider chooser or an IdP.
- It rewrites the loopback callback `http://127.0.0.1[:port]/?code=…&state=…`
  to `{app}/?oauth-code=…&oauth-state=…`.
- Everything else goes to Capacitor's default.
- Capacitor injects its native bridge only into the app origin
  (`addDocumentStartJavaScript` with the allowed origins), so the gateway's
  pages never see it.
- Compiles: `nix develop --command ./gradlew :app:compileDebugJavaWithJavac`
  → exit 0. No APK was installed or run on a device or emulator this round.

**Tests** (`src/platform/oauth.test.ts`, 18):
- transport header selection (Bearer vs session token, never both);
- concurrent 401s → **one** refresh, each request retried once;
- a second 401 after the refresh → returned, no second refresh;
- `session_expired` → tokens cleared in memory and storage;
- token mode never refreshes;
- PKCE challenge = Node `sha256(verifier).base64url`, plus the authorize
  parameters;
- redemption with the verifier → oauth gateway saved, URL cleaned;
- bogus code (400) → nothing stored, failure notice;
- state mismatch → the gateway is never contacted, nothing stored;
- a callback with no pending sign-in → nothing stored;
- pending with no code → cancelled;
- bridge-level: probe with providers, oauth-connected config, the no-op
  save, login never settles, logout clears and posts Bearer, connected
  descriptor/WS with the access token.

**Mutation checks:** sending both headers, removing the single-flight map,
dropping the state comparison, or not clearing on `session_expired` each
fails exactly one test.

**Live end to end against a real gated gateway**
(`scripts/gated-signin-e2e.mjs`, optional per the brief).
- A second scratch gateway, `/tmp/hermes-gated-home` on 127.0.0.1:19729, with
  `HERMES_DASHBOARD_BASIC_AUTH_*`. The gate engages only for a non-loopback
  public URL, so `HERMES_DASHBOARD_PUBLIC_URL=http://gated.test:19729` is set
  while still **binding 127.0.0.1**; nothing is exposed on the network.
  Result: `auth_required: true`, providers listed, `/api/sessions` → 401
  without auth.
- Headless Chromium drives onboarding → URL → the probe's "Sign in" (the
  password copy) → the gateway's real `/login` form → loopback redirect.
  A request route stands in for `MainActivity` → the app redeems the code
  and boots connected.
- Asserts:
  - every authed `/api/` call carries Bearer only (the public
    `/api/auth/providers` and `/api/status` excluded);
  - an open, receiving WS with `?token=`;
  - the saved oauth gateway;
  - a cleaned URL;
  - zero page errors.
- Each boot opens two gateway sockets: one closes after ~0.3–0.5 s, one stays
  open. Both received frames, so neither was rejected. The first version of
  the check took the first socket and flaked once; it now requires an open,
  receiving socket.
- Final run, verbatim (token redacted by the script):

```
probe → gated, password provider: "Sign in" button shown
gateway login page: /login
  ws open, 17 frames received
  ws closed after 346ms, 3 frames received
loopback callback intercepted: yes; app URL cleaned: true
saved gateway: authMode=oauth token=set refreshToken=set expiresAt=1792802089
REST auth seen: bearer
WebSocket: ws://127.0.0.1:19729/api/ws?token=<redacted> open, receiving
GATED E2E OK: native sign-in → connected with Bearer REST and token WebSocket
exit=0
```

**Regression caught by the token smoke.** The first, longer onboarding copy
pushed "Save and reconnect" below the first screen at 390×844 (save at
851–854 > 844). That failed 3/3 smokes; the copy was tightened and they pass.

**Gates** (final code, in order, all exit 0):

```
npm run typecheck                                        → exit 0
npm run build                                            → exit 0
npx vitest run src/platform src/app/open-session.test.ts → exit 0
  Test Files  5 passed (5)
  Tests  78 passed (78)
node --test scripts/smoke-classifier.test.mjs            → exit 0
  # tests 8
  # pass 8
  # fail 0
node scripts/smoke.mjs … (token-mode rig)                → exit 0, 3 consecutive runs
node scripts/gated-signin-e2e.mjs … (gated gateway)      → exit 0
```

Final token-mode smoke run, verbatim (token redacted):

```
screenshot: /tmp/smoke-out/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] first-run overlay: provider picker after 2.5s (gateway has no model provider) → skipped
[tablet] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] first-run overlay: none (provider configured or previously skipped)
screenshot: /tmp/smoke-out/4-connected-phone-390.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[phone] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/5-phone-drawer-open.png
screenshot: /tmp/smoke-out/6-phone-settings.png
screenshot: /tmp/smoke-out/7-phone-capabilities.png
screenshot: /tmp/smoke-out/8-phone-onboarding.png
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/9-phone-drawer-project.png
[phone] drawer browsing: project drill-in and "All projects" kept the drawer open
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/10-phone-drawer-two-open-sessions.png
[phone] focus switch: Smoke beta → already-open Smoke alpha (no route change) dismissed the drawer
page errors: 0 (none tolerated)
SMOKE OK: onboarding → connected chat surface (tablet + phone), thread-list switching works, zero page errors, zero bridge errors
exit=0
```

### Round 15 (2026-10-23): card kebab/timestamp taps dismiss the drawer again

**What regressed (round 14, 87f702d).**
- Round 14 excluded every press inside `[data-reorder-handle],
  [data-row-actions]`. But `[data-row-actions]` only marks a region excluded
  from **drag**.
- In **card** mode the actions cluster sits **inside** the main RowButton
  (`session-row.tsx:302-340`, `:553-566`). Its ⋯ kebab (no propagation
  guard) and its focusable `<time>` stamp (`:233-241`) bubble to the row's
  click handler and call `onResume()` (`:438-454`).
- So a card kebab or timestamp tap selected the session (often focus-only,
  no URL change) and the drawer stayed open. The reviewer's
  actual-component probe: 1 resume, 0 close events (round 13: 2).
- Compact rows were unaffected: their actions cluster is a **sibling** of
  the RowButton.

**Fix** (`src/platform/phone-layout.ts:95`, `:120`). Exclude only the
nested controls that **stop their click before it reaches the row**, so they
never resume: `[data-reorder-handle], [data-pr-link]`.
- **Audit.** `grep stopPropagation` over `src/app/chat/sidebar/**` and
  `src/app/chat/pr-tag.tsx` turned up only two such controls **inside a
  session RowButton**:
  - the reorder handle (`chrome.tsx:348-349`);
  - the **PR chip** (`pr-tag.tsx:54-61`: `data-pr-link`, stops click and
    pointerdown, opens the PR externally). It is in the row's trailing slot
    (`session-row.tsx:212`), so it sits inside the body in card mode. The
    brief named only the handle; this is the one other control, excluded
    exactly as the brief instructs for that case.
- Every other hit is outside session rows:
  - the header "+" buttons (`chrome.tsx:81`);
  - lane and project menus (`projects/workspace-header.tsx:182`,
    `project-menu.tsx:214,266`);
  - the connection switcher (`connection-switcher.tsx:79,135,164`);
  - sidebar header nav (`sidebar/index.tsx:1857,1888`);
  - the row's own modifier-click branch (`session-row.tsx:458`).
- Plugin contributions in the row's `SessionRowSlot` areas are unknown code;
  a plugin control that stops its click inside a card row would need adding
  here.
- `[data-row-actions]` is no longer excluded. Compact actions have no
  RowButton ancestor (so they're never selections), and card actions resume
  (so they're selections and dismiss).

**Coverage** (`src/platform/phone-layout.test.ts`, 16 tests). The card
fixture now carries the real card cluster inside the body: the `<time>`
stamp, a PR chip with its real `stopPropagation`, and the ⋯ kebab. New cases:
- card **kebab** tap on an unfocused row → 1 resume, dismisses (`:235`);
- card **timestamp** tap on an unfocused row → 1 resume, dismisses (`:235`);
- **compact kebab** (outside the RowButton) → 0 resumes, stays (`:247`);
- card **PR chip** → 0 resumes, stays (`:257`).

The existing handle (compact and card, focused and unfocused), body,
Unread-unmount, focus-switch, browsing, ⇧-click and outside/tablet cases are
kept and pass.

**Negative controls:**
1. `[data-row-actions]` re-added to the exclusion. Exactly the card kebab and
   timestamp tests fail:

```
 × dismisses when a card row's kebab tap resumes an unfocused session
 × dismisses when a card row's time tap resumes an unfocused session
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
      Tests  2 failed | 14 passed (16)
```

2. Exclusion reduced to the handle only (no `[data-pr-link]`). The PR chip
   test fails, so that exclusion is load-bearing:

```
 × keeps the drawer for a card row's PR chip (stops its click: no resume)
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
      Tests  1 failed | 15 passed (16)
```

**Smoke flake found and fixed.** In the first batch of three smokes, run 2
failed in the phone composer step: `[phone] composer not usable`.
- A probe showed the composer's editor element is **replaced once** while
  the restored session boots: mounts at `[0, 572]` and `[0, 931]` ms after
  the composer first appears. Text typed into the first editor is
  discarded with it; focus had landed on the doomed element.
- This is the unchanged upstream renderer's boot sequence, not the drawer
  change.
- The smoke now types only after the same editor element has stayed mounted
  for 1.5 s, up to 15 s (`scripts/smoke.mjs:277-306`). If it never settles,
  that's reported as `the composer editor kept remounting for 15s`.
- After that: **5 consecutive** green runs.

**Gates** (final code, in order, all exit 0):

```
npm run typecheck                                        → exit 0
npm run build                                            → exit 0
npx vitest run src/platform src/app/open-session.test.ts → exit 0
  Test Files  4 passed (4)
  Tests  60 passed (60)
node --test scripts/smoke-classifier.test.mjs            → exit 0
  # tests 8
  # pass 8
  # fail 0
node scripts/smoke.mjs …                                 → exit 0, 5 consecutive runs (after the
                                                           composer-stability fix; first batch: 2/3)
```

Final smoke run, verbatim (token redacted):

```
screenshot: /tmp/smoke-out/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] first-run overlay: provider picker after 2.7s (gateway has no model provider) → skipped
[tablet] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] first-run overlay: none (provider configured or previously skipped)
screenshot: /tmp/smoke-out/4-connected-phone-390.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[phone] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/5-phone-drawer-open.png
screenshot: /tmp/smoke-out/6-phone-settings.png
screenshot: /tmp/smoke-out/7-phone-capabilities.png
screenshot: /tmp/smoke-out/8-phone-onboarding.png
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/9-phone-drawer-project.png
[phone] drawer browsing: project drill-in and "All projects" kept the drawer open
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/10-phone-drawer-two-open-sessions.png
[phone] focus switch: Smoke beta → already-open Smoke alpha (no route change) dismissed the drawer
page errors: 0 (none tolerated)
SMOKE OK: onboarding → connected chat surface (tablet + phone), thread-list switching works, zero page errors, zero bridge errors
exit=0
```

### Round 14 (2026-10-23): a reorder-handle tap no longer dismisses the drawer

**What regressed (round 13, b19d919).**
- Round 13 classified **any** press inside a session row's RowButton as a
  selection.
- The reorder grab handle lives **inside** that RowButton:
  - compact rows put `SidebarRowGrab` directly in the body
    (`session-row.tsx:473-483`);
  - card rows put it inside the body's header line (`:553-554`).
- The handle deliberately stops its click (`chrome.tsx:348-349`,
  `data-reorder-handle`), so the row's resume handler never runs.
- The drawer's capture listener had already recorded "selects", so a
  sub-threshold tap on an unfocused row's handle closed the drawer
  **without** selecting anything. The reviewer's real-component probe: 0
  resumes, 2 close events (round 12: 0).

**Fix** (`src/platform/phone-layout.ts:90`, `:115-116`).
- At pointerdown, a press inside `[data-reorder-handle], [data-row-actions]`
  is **not** a press on the row itself. That is the exact predicate
  `session-row.tsx:396` already uses to keep its drag gesture off those
  controls, which are the only nested non-resume controls. *(Round 15
  correction: wrong. `[data-row-actions]` marks a region excluded from
  **drag**, not from selection. In card mode its kebab and timestamp sit
  inside the body and DO resume. Round 15 narrows the exclusion.)* The `grep
  stopPropagation` over `sidebar/chrome.tsx` and `session-row.tsx` finds:
  - the handle (`chrome.tsx:349`);
  - the header "+" buttons (`:81`), which aren't in session rows;
  - the row's own modifier-click branch (`session-row.tsx:458`).
- Such a press is not classified as a selection, and its row isn't kept for
  the selected-row fallback. It dismisses only if it actually navigated.
- That also keeps the drawer open for a tap on the **focused** row's
  handle, which round 12's selected-row fallback would have closed.
- Everything else in the row body keeps the round-13 pointerdown
  classification, so the Unread-filter unmount case still dismisses.
- Cron rows are untouched: their `Tip` sets the body's `data-slot` to
  `tooltip-trigger`, so they never matched. The round-13 comment and README
  text calling them selections are corrected.

**Coverage** (`src/platform/phone-layout.test.ts`, 12 tests). New, for both
the **compact** and **card** layouts, with the handle's real
`stopPropagation` and a resume counter on the row:
- tap an unfocused row's reorder handle → 0 resumes, drawer stays;
- tap the focused row's handle → drawer stays;
- tap the row body → 1 resume, drawer dismisses.

The card fixture is built with DOM calls, as React does: the HTML parser
would split the ⋯ `<button>` nested inside the RowButton.

**Negative control:** `phone-layout.ts` restored to round 13 (`git show
b19d919:…`). Exactly the four handle tests fail; the unmount, focus-switch,
browsing and body tests pass:

```
✓ dismisses when selecting a session UNMOUNTS its row (Unread filter), focus-only, no URL change
✓ dismisses on a focus-only switch to an already-open session (row becomes selected)
✓ dismisses when re-selecting the focused session and on nav items
✓ keeps the drawer for browsing controls, even when they replace themselves
✓ keeps the drawer for ⇧-clicks (pin/archive) and the row actions kebab
× keeps the drawer when tapping an unfocused compact row's reorder handle (no resume)
× keeps the drawer when tapping the FOCUSED compact row's reorder handle
✓ dismisses when tapping the compact row body (resume)
× keeps the drawer when tapping an unfocused card row's reorder handle (no resume)
× keeps the drawer when tapping the FOCUSED card row's reorder handle
✓ dismisses when tapping the card row body (resume)
✓ closes on a tap outside, and does nothing at tablet width
```

**Gates** (final code, in order, all exit 0):

```
npm run typecheck                                        → exit 0
npm run build                                            → exit 0
npx vitest run src/platform src/app/open-session.test.ts → exit 0
  Test Files  4 passed (4)
  Tests  56 passed (56)
node --test scripts/smoke-classifier.test.mjs            → exit 0
  # tests 8
  # pass 8
  # fail 0
node scripts/smoke.mjs …                                 → exit 0, 3 consecutive runs
```

The live smoke has no reorder-handle step; this case is covered only by the
jsdom tests above. Final smoke run, verbatim (token redacted):

```
screenshot: /tmp/smoke-out/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] first-run overlay: provider picker after 1.8s (gateway has no model provider) → skipped
[tablet] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] first-run overlay: none (provider configured or previously skipped)
screenshot: /tmp/smoke-out/4-connected-phone-390.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[phone] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/5-phone-drawer-open.png
screenshot: /tmp/smoke-out/6-phone-settings.png
screenshot: /tmp/smoke-out/7-phone-capabilities.png
screenshot: /tmp/smoke-out/8-phone-onboarding.png
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/9-phone-drawer-project.png
[phone] drawer browsing: project drill-in and "All projects" kept the drawer open
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/10-phone-drawer-two-open-sessions.png
[phone] focus switch: Smoke beta → already-open Smoke alpha (no route change) dismissed the drawer
page errors: 0 (none tolerated)
SMOKE OK: onboarding → connected chat surface (tablet + phone), thread-list switching works, zero page errors, zero bridge errors
exit=0
```

### Round 13 (2026-10-23): drawer dismissal survives a filtered-row unmount

**What was still wrong (round 12, 349ff6f).** Round 12 decided "was that a
selection?" by watching the **pressed DOM node** after the click: did it
end up as the selected row? Selecting a session can destroy that node.
- With the Unread status filter on, tapping an already-open, unfocused,
  unread session A works like this:
  - `openSession` calls `markSessionRead` **before** focusing
    (`open-session.ts:110-114`);
  - the marker clears, so A no longer matches the filter
    (`sidebar/index.tsx:612-656`), and React unmounts the pressed row;
  - focus moves to A's tab without routing.
- Round 12 then saw no URL change and no connected selected row, so the
  drawer stayed open.
- Sibling case: any filter that can drop the pressed row on activation, e.g.
  search narrowing, fails the same way.

**Discriminator: decided at pointerdown, from the row's structure**
(`src/platform/phone-layout.ts:80-146`).
- A tap selects if it hits a nav item (`[data-sidebar="menu-button"]`), or
  an **entity row's main target**: a `RowButton` whose **direct parent** is
  a row shell wrapped in that row's context menu
  (`[data-slot="context-menu-trigger"]`, `:81`, `:110`).
- Verified against the components: `session-row.tsx` renders
  `SessionContextMenu` → `ActionsContextMenu` → `ContextMenuTrigger asChild`
  → `SidebarRowShell` → `SidebarRowBody` (the RowButton). *(Round 14
  correction: this also claimed cron rows have the same shape. In source they
  do, but their `Tip` overrides the body's `data-slot` to `tooltip-trigger`,
  so they never match the RowButton test; the reviewer confirmed this on the
  rendered component.)*
- **Browsing controls never have that shape:**
  - "Show more" (`projects/workspace-header.tsx:85`) and Back / "All
    projects" (`projects/overview-row.tsx:66`) are RowButtons in **bare**
    shells with no context menu;
  - project drill-in (`overview-row.tsx:180`), lane headers
    (`projects/workspace-group.tsx:185`) and gateway group labels
    (`gateway-groups.tsx:272`) are `SidebarRowLink`s inside a
    `SidebarRowCluster`, not direct children of the shell, even where the
    shell has a context menu (`WorkspaceContextMenu`, `ProjectContextMenu`).
- **Audited in the real production DOM** at 390px (flat list, grouped
  overview, entered project):
  - Smoke alpha / Smoke beta → parent `context-menu-trigger` → selects;
  - "Open Smoke project" and "All projects" → parent `div` → browse.
  - "Show more" and gateway group labels don't render with this fixture (a
    long lane and several gateways/profiles would be needed); they are
    covered by the source analysis above and the unit test.
- ⇧-clicks on a session row (pin, archive, new window,
  `session-row-gesture.ts`) are not selections and keep the drawer (`:135`).
  ⌃-click (open in new tab, which focuses it) is a selection.
- Because the decision is made before the click, unmounting, focus-only and
  routed selections all dismiss. URL change and the round-12 "row became
  selected" check stay as fallbacks for any other row type (`:146`).

**Why the Unread-filter case is a unit test, not a smoke scenario.**
- Live on the scratch gateway, a session that is already **open** can't be
  unread. "Mark as unread" from its row menu didn't stick: the backend still
  reported `unread=False`, because opening clears the persisted flag
  (`clearUnreadOnOpen`). So the Unread filter showed no rows.
- The reviewer's case uses the **runtime** marker, which is set only when a
  background turn finishes. That needs a model provider, which the scratch
  gateway deliberately doesn't have.
- The Filters → Status → Unread path itself works headlessly via Radix
  keyboard navigation (pointer clicks on the submenu fail at 390px).
- So the case is covered by **`src/platform/phone-layout.test.ts`** (jsdom,
  the real `installPhoneLayout()` handlers, fixture rows mirroring the
  audited DOM). Its cases:
  - a tap whose click handler **removes the session row** (no URL change)
    must dismiss (`:64`);
  - a focus-only switch (row turns selected 50 ms later) dismisses (`:77`);
  - reselect and nav items dismiss (`:90`);
  - Show more / All projects / drill-in keep the drawer, **even when they
    remove themselves** (`:103`);
  - ⇧-click and the row kebab keep it (`:122`);
  - an outside tap closes it, and at tablet width nothing fires (`:131`).

**Negative control:** `phone-layout.ts` restored to round 12 (`git show
349ff6f:…`). Exactly the unmount case fails:

```
     × dismisses when selecting a session UNMOUNTS its row (Unread filter), focus-only, no URL change 438ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
      Tests  1 failed | 5 passed (6)
```

**Smoke P3: the focus-switch scenario now asserts its defining property.**
If the URL changed while focusing Smoke alpha, it fails with
`focus-switch scenario changed the URL … it must exercise a focus-only
selection` (`scripts/smoke.mjs:513-519`), instead of only logging "no route
change". A future routing change can no longer silently turn it into a
routed-switch test.

**Tooling note.** The Chromium 155.0.8059.79 store path used in earlier
rounds had been garbage-collected from the Nix store. `nix build
nixpkgs#chromium` fetched 155.0.8059.84 from cache.nixos.org (Nix store
only, nothing installed globally), and all round-13 runs use it.

**Gates** (final code, in order, all exit 0):

```
npm run typecheck                                        → exit 0
npm run build                                            → exit 0
npx vitest run src/platform src/app/open-session.test.ts → exit 0
  Test Files  4 passed (4)
  Tests  50 passed (50)
node --test scripts/smoke-classifier.test.mjs            → exit 0
  # tests 8
  # pass 8
  # fail 0
node scripts/smoke.mjs …                                 → exit 0, 3 consecutive runs
```

Final smoke run, verbatim (token redacted):

```
screenshot: /tmp/smoke-out/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] first-run overlay: provider picker after 1.7s (gateway has no model provider) → skipped
[tablet] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] first-run overlay: none (provider configured or previously skipped)
screenshot: /tmp/smoke-out/4-connected-phone-390.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[phone] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/5-phone-drawer-open.png
screenshot: /tmp/smoke-out/6-phone-settings.png
screenshot: /tmp/smoke-out/7-phone-capabilities.png
screenshot: /tmp/smoke-out/8-phone-onboarding.png
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/9-phone-drawer-project.png
[phone] drawer browsing: project drill-in and "All projects" kept the drawer open
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/10-phone-drawer-two-open-sessions.png
[phone] focus switch: Smoke beta → already-open Smoke alpha (no route change) dismissed the drawer
page errors: 0 (none tolerated)
SMOKE OK: onboarding → connected chat surface (tablet + phone), thread-list switching works, zero page errors, zero bridge errors
exit=0
```

### Round 12 (2026-10-23): drawer dismisses on a session focus switch

**What regressed (round 11, 3af0bf9).**
- Round 11 recognized a session selection only if the URL changed or the
  tapped row was **already** the selected row when pressed.
- Tapping a session that is already open in another tile/tab, but not
  focused, is neither:
  - a plain row click resumes it (`session-row.tsx:451`) →
    `openSession` (`contrib/wiring.tsx:1157`), which only **focuses** the
    existing tile/tab (`open-session.ts:199`; `store/session-states.ts`);
  - there is no route change, and at press time its row carried the
    row-**open** background, not row-active (`session-row.tsx:185,368`).
- So the drawer stayed open. Reproduced live at 390px, then covered by the
  smoke. Round 10's broad rule had dismissed these.

**Discriminator: the selection outcome, read after the click**
(`src/platform/phone-layout.ts:74-145`).
- The sidebar paints a session row's shell (the RowButton's direct parent)
  `bg-(--ui-row-active-background)` exactly when that session is the
  focused one (`sidebar/index.tsx` selection, `session-row.tsx:364`).
- So the drawer now records the pressed RowButton at pointerdown (`:102`).
  After the click it closes if any of these is true (`:134`):
  - a nav item was tapped (`[data-sidebar="menu-button"]`, all call
    `onNavigate`);
  - the URL changed;
  - **that row is the selected row once the click has settled**. It polls
    each frame for up to 300 ms (`:78`, `:142`), because the focus change
    commits through the session stores a few frames later.
- This covers a routed switch, re-selecting the current session and the
  focus-only switch.
- Browsing controls keep the drawer open. "Show more", project drill-in /
  "All projects" and group expansion never get a row-active shell, never
  navigate and aren't nav items.
- Why not a session attribute: session rows render the shared `RowButton`
  with no session-specific attribute, and card-mode rows even drop their
  actions slot. Selection state is the one signal the component itself
  defines. Reading it **after** the click, not at press time, is the fix.

**Smoke** (`scripts/smoke.mjs:436-518`), in its own phone context:
1. Put Smoke alpha in main, then ⌃-click Smoke beta in the drawer (= open in
   a new tab).
2. Require Smoke alpha's row to be "open" and Smoke beta's "selected"
   (screenshot `10-phone-drawer-two-open-sessions`: tabs "SMOKE ALPHA |
   SMOKE BETA").
3. Tap Smoke alpha. The drawer **must dismiss**, and Smoke alpha must then
   be the selected row.

- The run logs whether the route changed. Every run reported `no route
  change`, so the focus-only case really is what's exercised.
- Resuming a session on this provider-less gateway raises "Hermes couldn't
  finish the reply" toasts over the drawer (upstream behaviour). The step
  dismisses them via their "Dismiss notification" buttons before tapping.
- The round-11 browsing assertions (drill-in / "All projects" keep the
  drawer open) are unchanged and still pass.

**Negative control:** `app/src/platform/phone-layout.ts` restored to round
11 (`git show 3af0bf9:…`), rebuilt. Browsing still passes, the new
assertion fails:

```
[phone] drawer browsing: project drill-in and "All projects" kept the drawer open
SMOKE FAILED:
[phone] focusing the already-open "Smoke alpha" left the drawer open — a focus switch is a selection
exit=1
```

**Gates** (final code, in order, all exit 0):

```
npm run typecheck                               → exit 0
npm run build                                   → exit 0
npx vitest run src/platform                     → exit 0
  Test Files  2 passed (2)
  Tests  20 passed (20)
npx vitest run src/app/open-session.test.ts     → exit 0
  Test Files  1 passed (1)
  Tests  24 passed (24)
node --test scripts/smoke-classifier.test.mjs   → exit 0
  # tests 8
  # pass 8
  # fail 0
node scripts/smoke.mjs …                        → exit 0, 3 consecutive runs; after the negative
                                                  control and a rebuild, 3 more consecutive runs
```

Final smoke run, verbatim (token redacted):

```
screenshot: /tmp/smoke-out/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] first-run overlay: provider picker after 1.7s (gateway has no model provider) → skipped
[tablet] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] first-run overlay: none (provider configured or previously skipped)
screenshot: /tmp/smoke-out/4-connected-phone-390.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[phone] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/5-phone-drawer-open.png
screenshot: /tmp/smoke-out/6-phone-settings.png
screenshot: /tmp/smoke-out/7-phone-capabilities.png
screenshot: /tmp/smoke-out/8-phone-onboarding.png
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/9-phone-drawer-project.png
[phone] drawer browsing: project drill-in and "All projects" kept the drawer open
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/10-phone-drawer-two-open-sessions.png
[phone] focus switch: Smoke beta → already-open Smoke alpha (no route change) dismissed the drawer
page errors: 0 (none tolerated)
SMOKE OK: onboarding → connected chat surface (tablet + phone), thread-list switching works, zero page errors, zero bridge errors
exit=0
```

### Round 11 (2026-10-23): drawer dismissal scope + smoke boundary coverage

Gates, in this order, all exit 0 on the final build:

```
npm run typecheck                               → exit 0
npm run build                                   → exit 0
npx vitest run src/platform                     → exit 0
  Test Files  2 passed (2)
  Tests  20 passed (20)
node --test scripts/smoke-classifier.test.mjs   → exit 0
  ok 1 - no page errors → no problems
  ok 2 - the formerly tolerated getSnapshot loop now fails, in every phase
  ok 3 - a single occurrence fails — there is no count allowance
  ok 4 - the markDirty variant (typing) fails as a render-loop regression
  ok 5 - every error is reported, one problem each, other errors as plain pageerrors
  ok 6 - console: an error-boundary report is a problem
  ok 7 - console: a caught render-loop error logged by React is a problem
  ok 8 - console: unrelated HTTP resource diagnostics are not problems
  # tests 8
  # pass 8
  # fail 0
node scripts/smoke.mjs …                        → exit 0 on 8 runs of the final code
                                                  (5 consecutive, then 3 consecutive on the
                                                  rebuilt final dist after the negative controls)
```

**1. Drawer dismissal no longer catches sidebar browsing controls** (a
round-10 regression).
- Round 10 closed the phone drawer on any `[data-slot="row-button"]` tap.
  That attribute comes from the shared `RowButton`
  (`src/components/ui/row-button.tsx`), which `chrome.tsx` uses for session
  rows (`SidebarRowBody`) **and** for browsing controls: "Show more"
  (`projects/workspace-header.tsx:86`), project drill-in and Back
  (`projects/overview-row.tsx:180,67`; entering a project never opens a
  session) and group expansion (`gateway-groups.tsx:272`). No session-only
  attribute exists in that markup.
- The discriminator is now a selection, verified against the components
  (`src/platform/phone-layout.ts:65-93`, `selectsInPlace`). The drawer
  closes when:
  - the URL changed;
  - a nav item was tapped (`[data-sidebar="menu-button"]`; every one calls
    `onNavigate`, `sidebar/index.tsx`);
  - the tapped RowButton's own row (its direct parent, `SidebarRowShell`) is
    the selected one, painted `bg-(--ui-row-active-background)` by
    `session-row.tsx:364`, i.e. re-selecting the open session.
- Browsing controls are none of these, so the drawer stays open.
- **Smoke** (`scripts/smoke.mjs:395-432`): a phone context with the
  sidebar's project grouping on (the persisted
  `hermes.desktop.agentsGroupedByWorkspace` flag) taps "Open Smoke project"
  in the drawer, then its "All projects" back row. The drawer must stay open
  after both, and the overview must come back. This needs the seeded "Smoke
  project" (`hermes project create`, see "Boot smoke").
- **Negative control:** with round 10's rule restored (`rowButton` alone
  closes), the rebuilt app fails the smoke:

```
SMOKE FAILED:
[phone] project drill-in ("Open Smoke project") closed the drawer — browsing must keep it open
exit=1
```

**2. The smoke now catches boundary-caught render errors.**
- React error boundaries catch render errors, so they never reach
  `pageerror`. `src/components/error-boundary.tsx:53` reports them with
  `console.error("[error-boundary:<label>]", …)`, and React logs the caught
  error too. A boundary may also auto-recover, so the DOM check alone can
  miss it.
- `classifyConsoleError` (`scripts/smoke-classifier.mjs:39-55`) turns
  boundary reports and any logged "Maximum update depth exceeded" into
  problems, as they occur (`scripts/smoke.mjs:56`).
- Unrelated HTTP resource diagnostics (the gateway's 409, connection
  refusals) stay informational. The tests are `smoke-classifier.test.mjs`
  6–8.
- The 820px tablet phase now asserts the workspace is still alive after its
  Settings round-trip (`smoke.mjs:252`), and the drawer-browsing context
  ends with the same check.
- The steps run inside `run()` (`smoke.mjs:77`), so a fatal step is
  reported (`fatal: …`, `smoke.mjs:439`) together with everything collected
  before it, instead of an uncaught exception that hid the earlier findings.
- **Negative control:** with the assistant-ui patch removed, the smoke
  reports the caught errors (deduplicated, `×N` = repeats):

```
SMOKE FAILED:
[tablet] render-loop regression (patches/@assistant-ui+core+0.2.23.patch), caught and logged: Error: Maximum update depth exceeded. The result of getSnapshot should be ca
[tablet] error boundary caught a render error: [error-boundary:contrib:workspace] Error: Maximum update depth exceeded. The result of getSnapshot should be cached to avoi
[tablet] switching to "Smoke beta" did not render its transcript
[tablet] switching to "Smoke alpha" did not render its transcript
[tablet] an error boundary is showing ("… failed to render") — the main surface crashed
fatal: locator.waitFor: Timeout 45000ms exceeded.
×13 [tablet] render-loop regression (patches/@assistant-ui+core+0.2.23.patch): Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite 
×13     at http://127.0.0.1:4174/assets/capabilities-B1fqOH3C.js:4:1991
[tablet] render-loop regression (patches/@assistant-ui+core+0.2.23.patch): Maximum update depth exceeded. This can happen when a resource repeatedly calls setState inside
    at qg.markDirty (http://127.0.0.1:4174/assets/capabilities-B1fqOH3C.js:4:3887)
exit=1
```

**3. The "transcripts followed" line is printed only when that phase added
no problems** (`smoke.mjs:168,206`). In the negative control above it was
not printed: 0 occurrences.

**Also: the phone composer step waits for focus.** One run typed before
the tap's focus had landed, so the text went nowhere. The step now waits up
to 5 s for the composer to own focus before typing, and reports `tapping
the composer did not focus it` if it never does (`smoke.mjs:277-294`), so a
real focus regression still fails.

Final smoke run, verbatim (token redacted):

```
screenshot: /tmp/smoke-out/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] first-run overlay: provider picker after 2.2s (gateway has no model provider) → skipped
[tablet] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] first-run overlay: none (provider configured or previously skipped)
screenshot: /tmp/smoke-out/4-connected-phone-390.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[phone] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/5-phone-drawer-open.png
screenshot: /tmp/smoke-out/6-phone-settings.png
screenshot: /tmp/smoke-out/7-phone-capabilities.png
screenshot: /tmp/smoke-out/8-phone-onboarding.png
[phone] first-run overlay: none (provider configured or previously skipped)
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/9-phone-drawer-project.png
[phone] drawer browsing: project drill-in and "All projects" kept the drawer open
page errors: 0 (none tolerated)
SMOKE OK: onboarding → connected chat surface (tablet + phone), thread-list switching works, zero page errors, zero bridge errors
exit=0
```

### Round 10

Round 10 (2026-10-23, assistant-ui render-loop fix). Gates run in this
order, all exit 0:

```
npm run typecheck                               → exit 0
npm run build                                   → exit 0
npx vitest run src/platform                     → exit 0
  Test Files  2 passed (2)
  Tests  20 passed (20)
node --test scripts/smoke-classifier.test.mjs   → exit 0
  ok 1 - no page errors → no problems
  ok 2 - the formerly tolerated getSnapshot loop now fails, in every phase
  ok 3 - a single occurrence fails — there is no count allowance
  ok 4 - the markDirty variant (typing) fails as a render-loop regression
  ok 5 - every error is reported, one problem each, other errors as plain pageerrors
  # tests 5
  # pass 5
  # fail 0
node scripts/smoke.mjs …                        → exit 0, four runs, 0 page errors each (output below)
```

### Render-loop fix (round 10)

**Root cause, traced in this build:**
1. `@assistant-ui/core`'s `ThreadListRuntimeImpl` wraps its state in a
   `LazyMemoizeSubject` (`stateBinding`, binding `getThreadListState(core)`,
   which builds a **new** wrapper object on every call). But
   `ThreadListRuntimeImpl.subscribe()` forwards straight to
   `this._core.subscribe()`, **never to `stateBinding`**.
2. So the subject never gets a subscriber. `isConnected` stays `false`, and
   `LazyMemoizeSubject.getState()` takes its `!this.isConnected` branch on
   **every read**, returning a fresh object whose fields are all `===` the
   previous ones.
3. `ThreadListRuntimeClient` reads it via `useSubscribable(runtime)`, which
   is `@assistant-ui/tap`'s `useSyncExternalStore(runtime.subscribe,
   runtime.getState)`. Tap's post-commit check compares the render-time
   snapshot with a fresh `getSnapshot()`. Their identities always differ, so
   it forces another commit. After 50 commits its guard throws "Maximum
   update depth exceeded. The result of getSnapshot should be cached…".
4. The composer runtime uses the same `LazyMemoizeSubject` and showed the
   same pattern while typing: tap's `UpdateScheduler.markDirty` guard.

Instrumented dev build, 90 s on the connected chat surface: the thread-list
subject received **0** change notifications, and **23** shallow-equal
rebuilds were swallowed by the fix. So this was never "re-notifying every
commit", as rounds 2–9 described it; the subject was simply never
connected.

**Fix:** `patches/@assistant-ui+core+0.2.23.patch`, a one-line change in
`dist/subscribable/subscribable.js`.
`LazyMemoizeSubject.getState()` now keeps its previous snapshot when the
rebuilt one is shallow-equal: `if (newState !== SKIP_UPDATE &&
!shallowEqual(newState, this._previousState)) this._previousState =
newState;`. That is the rule its sibling `ShallowMemoizeSubject` already
uses. Real changes give a field a new identity, so they still produce a new
snapshot. The patch is applied by `patch-package` (devDependency, exact pin
8.0.1) on `postinstall`. A clean reinstall of `@assistant-ui/core` re-applied
it: `@assistant-ui/core@0.2.23 ✔`. The other possible fix, subscribing
`ThreadListRuntimeImpl.subscribe` through `stateBinding`, is left for an
upstream issue (`npx patch-package @assistant-ui/core --create-issue`).

**Evidence:**
- **Unit:** `src/platform/assistant-ui-patch.test.ts` checks that a
  disconnected subject returns the same snapshot for unchanged state, and
  still a new one when a field changes (disconnected and connected). Against
  the unpatched file, the stability test fails (1 failed | 1 passed).
- **Production build, before → after, 1280 and 390px:**
  - boot + typing: 6–11 getSnapshot + 1–4 markDirty page errors → **0**;
  - typing right after boot (which crashed the workspace in 3/6 runs
    before): **0/6 crashes, 0 errors**.
- **Thread list still updates:** the smoke switches Smoke alpha → Smoke
  beta → Smoke alpha at 1280px (sidebar) and 390px (drawer). Each switch
  must render that session's transcript and not the other's. Both widths
  pass with 0 page errors.
- **Negative control:** the same smoke against a build **without** the patch
  exits 1. During the 1280px session switches the workspace fell into its
  error boundary and the composer never came back (excerpt, stacks omitted):

```
screenshot: /tmp/smoke-out-np/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] first-run overlay: provider picker after 2.4s (gateway has no model provider) → skipped
[tablet] console.error: Error: Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.
[tablet] console.error: [error-boundary:contrib:workspace] Error: Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.
[tablet] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out-np/2-connected-1280.png
locator.waitFor: Timeout 45000ms exceeded.
  - waiting for locator('[contenteditable="true"], textarea').first() to be visible
exit=1
```

- **No tolerance remains.** `scripts/smoke-classifier.mjs` reports every page
  error as a problem. "Maximum update depth exceeded …" is labelled a
  render-loop regression of the patch. The guard-site scan, count bounds and
  phase allowances of rounds 3–9 are gone, and the classifier tests now
  assert that the formerly tolerated shape fails.

**Phone drawer fix found by the new switching check.** Tapping the session
that was already open didn't change the URL, so the drawer stayed open (the
"same-URL selection" gap noted in round 1). `phone-layout.ts` now also
closes the drawer when a tap selects a session row
(`[data-slot="row-button"]`) or nav item (`[data-sidebar="menu-button"]`).
The smoke's phone sequence starts by tapping the already-open session.
*(Round 11 narrowed this: `[data-slot="row-button"]` also covers browsing
controls, so only the selected row counts.)*

### Earlier verification notes

- **`dist/` was stale at the start of round 9.** `dist/index.html` referenced
  an `index-*.js` the build directory no longer contained, so the preview's
  HTML fallback answered `200 text/html` for it and the page stayed blank.
  Always run `npm run build` before a smoke.

- **`bridge.test.ts` (18 tests).** Beyond URL/transport mapping it covers:
  - cross-host blank-token refusal on both save paths;
  - the same-endpoint token kept, and a label-only edit saved in place;
  - test → save → reload for a material registry edit. It asserts the
    `/api/ws` probe URL and token **of the new gateway** and that a reload is
    scheduled only after 400 ms, using fake timers and a `pageLifecycle.reload`
    spy;
  - a failed WebSocket probe (registry save **and** apply) persists nothing
    and schedules no reload;
  - a registry row's **Test** contacting the **saved** gateway (B: REST,
    token, WS) while `api()` stays on the booted gateway (A);
  - apply without a token refused;
  - a body stall after headers.

  **Mutation check (round 6):** removing the WS probe fails 3 tests, removing
  the reload fails 1, and pointing Test back at the booted gateway fails 1.
- `npm run build` emits `Collapse-Bold-*.woff2`; the smoke checks that it
  loads.
- `npx vitest run` (full suite) — not rerun since round 2. Round 2 result:
  **FAILING**, 27 of 1012 files and 64 of 8403 tests (8332 passed), mostly
  12–15s timeouts under heavy host load. Not triaged. No tests are excluded.
- `cap sync` / gradle — **not run** (no `android/`, no SDK).

### Phone audit (round 9, 390×844, touch, production build)

Each surface was walked in headless Chromium against the scratch gateway.
Measured: document overflow, plus visible text or controls extending past
the viewport outside the drawer. Each screenshot was also reviewed by eye.

| Surface | Before | Fix (phone-layout.ts) | After |
| --- | --- | --- | --- |
| Chat | no overflow; statusbar's last pill past the edge, inside the row that already scrolls (round 3) | — | unchanged |
| Sessions drawer | fine (round 3 fixes) | — | unchanged |
| Settings (titlebar gear) | overlay card 300px of 390 (44px gutters each side); body copy wraps to 3–4 lines | `[data-overlay-surface]` side/bottom padding → `0.5rem` | card 374px |
| Scheduled jobs | same 300px card; blueprint list squeezed into a short scroll box | same rule | card 374px, full blueprint list visible |
| Capabilities / Skills | no overflow | — | unchanged |
| Messaging / Profiles | no overflow | — | unchanged |
| Onboarding | the four connection-mode cards all as tall as the tallest (`auto-rows-fr`, ~116px each); URL field and Save below the fold | `.auto-rows-fr` → `grid-auto-rows: auto` (only used by that grid) | URL field and "Save and reconnect" on the first screen |

The "Search Ctrl K" pill straddling the top edge of overlay cards is
upstream's design (also at desktop widths) and was left alone.

### Smoke: executed, PASSED (zero page errors, none tolerated)

Scratch gateway (`hermes serve --port 19719` + `hermes gateway run`,
throwaway `HERMES_HOME`, no model provider, the two seeded smoke sessions),
production build on `vite preview`, headless Chromium 155. The smoke:
- attaches one listener per page;
- asserts the connected surface at 1280 **and** 820px;
- checks that the Collapse font loads and that a `<webview>` reports
  "unavailable";
- waits for the first-run overlay to settle, and fails if it's still
  "Starting Hermes…" after 30 s;
- **switches sessions** Smoke alpha → Smoke beta → Smoke alpha in the
  1280px sidebar. Each session's own transcript must render and the other's
  must not be visible;
- at 820px, checks that overlay views keep upstream's ≥ 40px side gutters
  (the phone CSS must not leak to tablet);
- runs the phone checks:
  - the composer is on screen and takes typed text (not sent);
  - the same session switching through the drawer, which must close after
    each selection, including the already-open session;
  - the drawer opens and closes;
  - Settings opens from the titlebar with a card within 24px of the viewport
    width;
  - Capabilities opens from the drawer, which closes on that navigation;
  - browsing inside the drawer (project drill-in, "All projects") keeps it
    open (round 11);
  - switching focus to an already-open session (another tab) from the drawer
    dismisses it, even without a route change (round 12);
  - onboarding (no gateway) has its URL field and Save on the first screen;
  - no horizontal overflow on chat, the session transcript, settings,
    capabilities and onboarding;
- fails whenever an error boundary catches a render error: through its
  `console.error("[error-boundary:…]")` report as it happens, and through
  the "… failed to render" fallback at 1280px, after the 820px Settings
  round-trip and on phone;
- fails on any logged "Maximum update depth exceeded", even when caught;
- **fails on any uncaught page error**, via `scripts/smoke-classifier.mjs`;
- reports a fatal step together with everything collected before it.

Round-10 run, verbatim (token redacted; the round-11 run is in "Round 11"
above):

```
screenshot: /tmp/smoke-out/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] first-run overlay: provider picker after 3.1s (gateway has no model provider) → skipped
[tablet] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] first-run overlay: none (provider configured or previously skipped)
screenshot: /tmp/smoke-out/4-connected-phone-390.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[phone] thread list: switched Smoke alpha → Smoke beta → Smoke alpha, transcripts followed
screenshot: /tmp/smoke-out/5-phone-drawer-open.png
screenshot: /tmp/smoke-out/6-phone-settings.png
screenshot: /tmp/smoke-out/7-phone-capabilities.png
screenshot: /tmp/smoke-out/8-phone-onboarding.png
page errors: 0 (none tolerated)
SMOKE OK: onboarding → connected chat surface (tablet + phone), thread-list switching works, zero page errors, zero bridge errors
exit=0
```

Earlier rounds (kept for history):
- Rounds 3–9 tolerated the render-loop error by message, then by build-derived
  guard site, phase and count bound. Round 10 fixed the loop and removed all
  tolerance.
- Round 6's classifier accepted a top frame anywhere in the ~534 KB
  `capabilities-*.js` chunk. Reviewers showed that an unrelated same-message
  throw elsewhere in that chunk passed; round 7 pins it to the guard site.
- Round 5's smoke tolerated every page error with the exact message,
  unbounded. Reviewers showed that this passed injected unrelated errors;
  round 6 replaced it with the classifier above.
- Round 3 failed on these same render-loop page errors; the phone step
  passed.
- Round 2's "no uncaught page errors" note was wrong: that run aborted before
  it printed them.

**The 409** is `POST /api/sessions/owner-backfill`, which the renderer fires
once per scope (`src/lib/legacy-session-owner-backfill.ts`) to stamp
pre-ownership session rows. The gateway answers `409 {"detail":"Exclusive
maintenance refused: Gateway runtime already owns profile …. Drain and stop
the gateway, then retry."}` whenever `hermes gateway run` owns the profile,
which the scratch setup needs and which most real remote gateways have.
Electron desktop takes the same path (`hasRegistryTopology()` is true whenever
`connections.list` exists), so this is **upstream behavior, not a port
defect**. It is fire-and-forget, and the renderer re-arms it on the next
session-list refresh. Not changed.

**The first-run "Let's get you setup with Hermes Agent / Starting Hermes…
100%" overlay (round 9 diagnosis): not stuck, and the same as upstream.**
- It is `DesktopOnboardingOverlay` (`src/components/onboarding/index.tsx`).
  It shows "Starting Hermes…" while `$desktopOnboarding.configured` is
  `null`. `refreshOnboarding` → `checkRuntime` → `evaluateRuntimeReadiness`
  then issues **two WebSocket RPCs in parallel, `setup.status` and
  `setup.runtime_check`**, and the overlay becomes the provider picker
  (`configured: false`) or hides (`true`).
- Timeline measured in the production build at 1280px against the scratch
  gateway:
  - 2.8 s: "Starting Hermes…";
  - 5.1 s: WS open, both RPCs sent;
  - `setup.status` answers in 472 ms with `{"provider_configured":false,…}`;
  - `setup.runtime_check` answers in 884 ms with `{"ok":false,"error":"Hermes
    is not connected to any AI provider yet. …"}`;
  - 7.8 s: provider picker.
- So nothing blocks. The overlay waits for the WebSocket connect plus those
  two RPCs, and the scratch gateway has no model provider. Earlier rounds'
  "stuck at 100%" screenshots were taken ~2 s after the connected DOM
  appeared, before the WebSocket had opened. That was worse under that day's
  heavy host load (load average 13–53).
- **Upstream Electron shows the same picker** for the same gateway, in the
  round-4 and round-9 runs with upstream's own preload.
- The smoke is now aware of it. It waits up to 30 s for the overlay to
  settle, logs which state it reached and how long it took, skips the picker
  ("I'll choose a provider later"), and **fails if it is still "Starting
  Hermes…" after 30 s**, which would mean the setup RPCs never answered.

### Upstream comparison (round 4): the render loop reproduces in Electron

Run on 2026-10-22: the **unmodified upstream renderer in real Electron**,
through upstream's own preload and main process, against the same scratch
gateway.

- **Setup:**
  - Copied `upstream/apps/{desktop,shared}` to `/tmp/updesk`; nothing under
    `upstream/` was modified.
  - `npm install --ignore-scripts --legacy-peer-deps`, standalone. The
    workspace install crashes npm's arborist with `Cannot read properties of
    null (reading 'edgesOut')`. The resolved `@assistant-ui/tap` 0.9.24, `core`
    0.2.23, `react` 0.14.24, `store` 0.2.22 and `react` 19.2.7 match `app/`
    exactly.
  - Scratch-only patches:
    - added `lucide-react@1.61.0`, which upstream gets hoisted from its
      monorepo root;
    - stubbed `node-pty`, whose native build was skipped (terminal only);
    - pointed `LD_LIBRARY_PATH` at Nix-store libraries so Electron 40.10.2
      loads on NixOS.
  - Built Electron main (`tsc --build tsconfig.electron.json` +
    `bundle-electron-main.mjs --dev`) and ran `vite` for the renderer.
  - Launched with `HERMES_DESKTOP_REMOTE_URL/TOKEN` (remote mode),
    `HERMES_DESKTOP_CDP_PORT=9333`, `--ozone-platform=headless`.
- **Measurement:** attached Playwright over CDP, reloaded the window and
  watched for 100s.
  - `getConnection()` → `{"mode":"remote","baseUrl":"http://127.0.0.1:19719"}`.
  - Same provider-setup gate as the port.
  - **5 × `pageerror: Maximum update depth exceeded. The result of
    getSnapshot should be cached to avoid an infinite loop.`**, the same count
    range as the port (4–7).
- **Conclusion:** the renderer source in `app/src` is byte-identical to
  upstream's (`diff -rq` differs only by `src/platform/`), the dependency
  versions are identical, and the error reproduces with upstream's own bridge.
  So it is not caused by the Android bridge, the entry order or dependency
  resolution. It's upstream behavior. **Round 10 fixed it in the port**
  with the `@assistant-ui/core` patch ("Render-loop fix"), deliberately
  diverging from upstream.
- **Round 9 addition:** typing in the same Electron harness crashed the
  workspace pane ("“workspace” failed to render") in 3/4 runs that typed
  right after boot, alongside 2× markDirty + getSnapshot errors per typing
  burst. Also fixed by the round-10 patch.

