# Hermes for Android

An Android (Capacitor) port of the **Hermes desktop app** — the Electron +
React renderer from `upstream/apps/desktop` (v0.17.6, hermes-agent 0.21.5).

- **Tablet (≥ 768px): desktop parity.** The renderer in `src/` is a near
  byte-identical copy of upstream; it runs unchanged.
- **Phone (< 768px): minimal adaptations** of the same layout, through one
  small adaptation layer (`src/platform/phone-layout.ts`) — not a forked
  component tree. *Status: not implemented yet* (the hook is an empty stub).
- **Remote gateway only.** Android cannot spawn the local Python agent, so the
  app is a client for a Hermes gateway running elsewhere (`hermes serve`),
  using the desktop's existing remote-connection mode.

`../upstream/` is the pristine upstream reference — never edit it. Re-vendor
it and 3-way diff against `app/src` to pick up upstream changes. Everything
Android-specific lives in `src/platform/` (each file is headed
"Android adaptation layer"), plus `index.html` → `src/platform/entry.ts`,
`vite.config.ts`, `vitest.config.ts`, `capacitor.config.ts`.

## How it works

The renderer's entire native surface is one object, `window.hermesDesktop`
(contract: `src/global.d.ts`; Electron's version: `electron/preload.ts`).
`src/platform/bridge.ts` implements it with fetch/WebSocket/web APIs and
`src/platform/entry.ts` installs it before any renderer module evaluates.

- A single saved gateway `{ name, httpUrl, token }` lives in localStorage
  (`src/platform/gateway-config.ts`). Every route/profile resolves to it —
  Electron's v1 "global remote" mode.
- No saved gateway → onboarding (`src/platform/onboarding.tsx`), which mounts
  the desktop's own **Settings → Gateway** panel. "Save and reconnect" tests
  HTTP (`/api/status`, then an authed `/api/sessions`) and the `/api/ws`
  WebSocket, saves, and reloads into the full app.
- `api(request)` (`src/platform/api-transport.ts`) mirrors Electron's
  `api-transport.ts`: `Authorization: Bearer <token>`, timeouts, multipart
  upload, same error shape.

## Bridge status

Every member of `window.hermesDesktop`. All non-optional members are present
(checked against `src/global.d.ts`), so no `hermesDesktop.* is not a function`
is possible from a missing required member.

### Full fidelity (same behavior as Electron remote mode)

- `getConnection` / `getConnectionFor` — `/api/status` probe → `HermesConnection` (mode `remote`, token, wsUrl)
- `getGatewayWsUrl` / `getGatewayWsUrlFor` — `ws(s)://…/api/ws?token=…` from the saved gateway
- `revalidateConnection` — re-probes `/api/status`
- `api` — fetch to the gateway with token auth, timeout, multipart upload
- `getProfileRoutes` — every profile routes to the one gateway
- `getConnectionConfig` / `saveConnectionConfig` / `applyConnectionConfig` / `testConnectionConfig` / `probeConnectionConfig` — drive the reused Gateway settings panel (remote + token only; apply = test then reload)
- `connections.list` / `.save` / `.setPrimary` / `.test` — a one-entry registry
- `profile.get` / `.set` / `.remember` / `.getDefault` / `.setDefault` — localStorage

### Web equivalent

- `notify` — Web `Notification` (asks permission on first use)
- `requestMicrophoneAccess` — `getUserMedia({ audio: true })`
- `writeClipboard` / `readClipboard` — `navigator.clipboard`
- `saveClipboardImage` — `navigator.clipboard.read()` image → in-memory file
- `openExternal` — `window.open(url, '_blank')`
- `selectPaths` — `<input type=file>`; files are held in memory under synthetic `/android-local/…` paths
- `getPathForFile` / `readFileDataUrl` / `readFileText` — register / read those in-memory files
- `saveImageBuffer` / `savePastedText` — in-memory files
- `saveImageFromUrl` — `<a download>`
- `normalizePreviewTarget` — http(s) URLs only (no local file previews)
- `getRecentLogs` — the bridge's own in-memory log (last 200 lines)

### Stubbed (present, returns the safest "unavailable"/empty value)

- Flags: `glassSupported`, `translucencySupported`, `localModelsEnabled`, `guestOnboardingEnabled` = `false`; `skipIntro` = `true`
- `touchBackend` → `{ ok: true }` (no local backend to keep warm)
- `getPoolLimits` / `setPoolLimits` → upstream defaults, not persisted
- `oauthLoginConnectionConfig` rejects; `oauthLogoutConnectionConfig` → not connected
- `getSecretStorageEncryption` → off; `setSecretStorageEncryption` rejects
- `sshConfigHosts` / `sshResolveHost` → empty
- `connections.remove` rejects (exactly one gateway)
- `cloud.status` / `.logout` → signed out; `cloud.login` / `.discover` / `.agentSignIn` reject
- Boot/bootstrap: `getBootProgress` → ready 100%; `getBootstrapState` → inactive; `continueBootstrapLocal` / `resetBootstrap` / `repairBootstrap` / `cancelBootstrap` → ok; `onBootProgress` / `onBootstrapEvent` / `onBackendExit` → no-op subscriptions
- `getVersion` → app version, `platform: 'android'`
- `updates.*` → unsupported ("update from the store"); `uninstall.*` → unsupported
- `claimAmbientCue` → `true`
- Windows: `openSessionWindow` / `openSessionInTerminal` / `openWindow` / `openBrowserWindow` → `{ ok: false }`; `onBrowserPopoutClosed` no-op; `windowControls` no-ops (`custom: false`)
- `petOverlay.*`, `quickEntry.*` → disabled / no-ops
- `watchPreviewFile` rejects; `stopPreviewFileWatch` → `true`; `onPreviewFileChanged` no-op
- `fetchLinkTitle` → `''`; `sanitizeWorkspaceCwd` → passthrough
- `settings.*` (default project dir) → none / cancelled
- `revealLogs` / `readDir` → unsupported
- `terminal.*` → unavailable (`start` rejects)
- `themes.fetchMarketplace` rejects; `themes.searchMarketplace` → `[]`
- `findInPage` → 0 results; `stopFindInPage` / `onFoundInPage` / `onOpenFindBarRequested` no-ops

### Absent (optional members; the renderer feature-detects and hides the UI)

- Agents/HUD: `getAgentRoster`, `wakeIndicator`, `introReveal`, `chatOnboarding`, `hud`, `hudModifier`, `screenshot`, `readWindowBelow`
- Files: `readFileDataUrlForAttach`, `dataUrlReadMax`, `readPluginSource`, `selectSavePath`, `saveGatewayFile`, `capturePreview`, `watchDirectory`, `renamePath`, `writeTextFile`, `trashPath`, `revealPath`, `openDir`, `gitRoot`, `git`
- Context menu: `contextMenuEdit`, `contextMenuCopyImage`, `contextMenuSpellcheck`, `contextMenuGuestAddWord`, `onContextMenuSpellcheck`
- Window/OS: `setActiveWork`, `setTitleBarTheme`, `setNativeTheme`, `setTranslucency`, `setKeepAwake`, `minimizeToTray`, `setPreviewShortcutActive`, `zoom`, `relaunchApp`, `getMachineProfile`, `getOnBattery`, `onBatteryChanged`, `onPowerResume`, `onWindowStateChanged`
- Preview: `openPreviewInBrowser`, `reachPreviewUrl`, `resolveFavicon`, `onClosePreviewRequested`, `onPreviewNav`
- Plugins: `desktopPluginsRoot`, `reconcileDesktopPlugins`, `probePluginRepo`, `installDesktopPlugin`, `removeDesktopPlugin`
- Connection/backend: `setActiveConnectionRoute`, `onConnectionApplied`, `onPoolBackendRetiring`, `recycleBackend`, `getRemoteDisplayReason`, `mcpOauth`
- Events/misc: `onOpenFolderRequested`, `onOpenUpdatesRequested`, `onDeepLink`, `signalDeepLinkReady`, `onFocusSession`, `onNotificationAction`, `onNotificationActivate`, `reportRendererError`, `logsRoot`

## Deviations and known limitations

- **No local backend.** Remote gateway only. The reused Gateway panel still
  shows the desktop's Local / Hermes Cloud / SSH mode cards; choosing any of
  them errors ("Android connects to a remote Hermes gateway only").
- **Token auth only.** OAuth-gated gateways are rejected; Hermes Cloud sign-in
  is unavailable.
- **One gateway.** No multi-connection registry; changing the gateway reloads
  the page instead of Electron's in-place re-dial.
- **Token storage** is the WebView's localStorage (app-private sandbox), not
  Android Keystore-encrypted, though `secureTokenStorage` reports `true`.
- **Attachments are in-memory** (`src/platform/local-files.ts`) and lost on reload.
- **No terminal, git, file browser, local file previews, pop-out windows, pet
  overlay, quick entry, find-in-page, in-app updates.**
- **Plain-http gateways** need `allowMixedContent: true` (`capacitor.config.ts`).
- **Phone layout not done** — `installPhoneLayout()` is an empty stub; phones
  get the unadapted desktop layout.
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
npm install
npm run typecheck          # tsc -p . --noEmit
npm test                   # vitest run (full suite is slow: ~1000 files)
npx vitest run src/platform  # bridge checks only
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
```

## Verification (2026-10-22, this machine)

- `npm run typecheck` — **pass** (exit 0).
- `npm run build` — **pass** (exit 0).
- `npx vitest run src/platform` — **pass**, 10/10 (`bridge.test.ts`).
- `npx vitest run` (full suite) — **FAILING**: 27 of 1012 files, 64 of 8403
  tests failed (8332 passed), 65 min wall-clock. Most failures hit the 12–15s
  test timeout (the host's load average was 13–53 during the run), mostly in
  composer/inline-edit, settings (model, local-models, providers) and
  transcript paging tests. Not yet triaged: whether they are load-induced
  flakes or real port breakage is unknown. No tests are excluded.
- `cap sync` / gradle — **not run** (no `android/`, no SDK).

### Smoke: executed, FAILED (partial)

Executed against a scratch gateway (`hermes serve --port 19719` + `hermes
gateway run`, throwaway `HERMES_HOME`, no model provider configured), built
app on `vite preview`, headless Chromium 155. Output, verbatim:

```
screenshot: /tmp/smoke-out/1-onboarding.png
[onboarding] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
locator.waitFor: Timeout 45000ms exceeded.
Call log:
  - waiting for locator('[data-slot="sidebar"], [data-sidebar="sidebar"]').first()
    at assertConnected (scripts/smoke.mjs:74:78)
    at scripts/smoke.mjs:97:7
```

What that means:

1. **Onboarding — works.** Fresh profile shows "Connect to a Hermes gateway"
   with the reused Gateway panel; URL + token filled; "Save and reconnect"
   tested the gateway and reloaded.
2. **Tablet (1280 / 820) — script passed, but not a real pass.** The sidebar
   and composer elements are in the DOM, yet both screenshots show the
   desktop's first-run overlay "Let's get you setup with Hermes Agent —
   Starting Hermes… 100%" covering the app, not a visible chat surface. Likely
   because the scratch gateway has no model provider; not confirmed. The
   script's DOM-presence check is too weak to catch this.
3. **Phone (390) — failed.** No sidebar element at phone width within 45s
   (phone layout is unimplemented; the desktop sidebar is probably not mounted
   at that width).
4. A **409 Conflict** from some gateway request on every page; which request
   is not yet identified.
5. No `hermesDesktop.* is not a function` errors and no uncaught page errors
   were recorded before the phone step aborted the run.
