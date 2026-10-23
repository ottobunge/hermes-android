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

### Full fidelity (single token gateway)

- `getGatewayWsUrl` / `getGatewayWsUrlFor` — `ws(s)://…/api/ws?token=…` from the booted gateway
- `getProfileRoutes` — every profile routes to the one gateway

### Web equivalent

- `getConnection` / `getConnectionFor` — `/api/status` probe → `HermesConnection` (mode `remote`, token, wsUrl)
- `revalidateConnection` — re-probes `/api/status`
- `api` — fetch with session-token auth, whole-exchange timeout, multipart upload
- `getConnectionConfig` / `saveConnectionConfig` / `applyConnectionConfig` / `testConnectionConfig` / `probeConnectionConfig` — drive the reused Gateway settings panel (remote + token only; save persists for the next boot; apply = test → save → reload; test without a usable token fails)
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
- `oauthLoginConnectionConfig` rejects; `oauthLogoutConnectionConfig` → not connected
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
- **Token auth only.** OAuth-gated gateways are rejected; Hermes Cloud sign-in
  is unavailable.
- **One gateway.** No multi-connection registry. Changing the gateway reloads
  the page instead of Electron's in-place re-dial, and the running page stays
  on the gateway it booted with until then.
- **Token storage** is the WebView's localStorage (app-private sandbox), not
  Android Keystore-encrypted, though `secureTokenStorage` reports `true`.
- **Attachments are in-memory** (`src/platform/local-files.ts`) and lost on reload.
- **No terminal, git, file browser, local file previews, pop-out windows, pet
  overlay, quick entry, find-in-page, in-app updates.**
- **HTTPS/WSS gateways are the supported path.** Plain `http://` sends the
  session token and traffic unencrypted, so use it only on a network you trust
  (LAN/tailnet). The onboarding copy says so. On a native Android build it
  will also need an explicit cleartext policy (`server.cleartext` or a
  `networkSecurityConfig`). `allowMixedContent` does **not** provide that, so
  it was removed from `capacitor.config.ts`. **That native policy decision is
  deferred until `android/` is generated**; until then, plain HTTP is only
  verified in the desktop-browser smoke.
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
```

Run `npm run build` before every smoke: a stale `dist/` serves a blank page
(round 9).

## Verification

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
  - onboarding (no gateway) has its URL field and Save on the first screen;
  - no horizontal overflow on chat, the session transcript, settings,
    capabilities and onboarding;
- fails whenever an error boundary shows "… failed to render";
- **fails on any uncaught page error**, via `scripts/smoke-classifier.mjs`.

Final run on the final build, verbatim (token redacted; three earlier runs
on the same code also exited 0 with `page errors: 0`):

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

