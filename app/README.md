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
  "HERMES AGENT" wordmark shrinks instead of clipping, and the statusbar
  scrolls sideways. All of it is gated on `max-width: 767.98px`.
- **Remote gateway only.** Android cannot spawn the local Python agent, so the
  app is a client for a Hermes gateway running elsewhere (`hermes serve`),
  using the desktop's existing remote-connection mode.

`../upstream/` is the pristine upstream reference — never edit it. Re-vendor
it and 3-way diff against `app/src` to pick up upstream changes. Everything
Android-specific lives in `src/platform/` (each file is headed
"Android adaptation layer"), plus `index.html` → `src/platform/entry.ts`,
`vite.config.ts` (including an alias that resolves the vendored stylesheet's
monorepo-relative `../../../node_modules/…` font URLs from `app/node_modules`),
`vitest.config.ts`, `capacitor.config.ts`.

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
  toggle or a tap outside. No bottom nav.
- **Render-loop errors on every page: the original loop is confirmed
  upstream behavior, not a port defect.** Each boot throws several (4–9 observed) uncaught `Maximum update depth exceeded.
  The result of getSnapshot should be cached…` errors at every width. Traced
  in a dev build: the loop is assistant-ui's thread-list store
  (`@assistant-ui/core` `ThreadListRuntimeImpl` state via `@assistant-ui/tap`'s
  `useSyncExternalStore`). Each commit re-notifies it and it hands back a
  fresh object whose fields are all `===` the previous ones, so tap's
  50-commit guard throws. The app still renders and works afterwards. See
  "Upstream comparison" below for the Electron reproduction. The smoke
  tolerates only errors thrown by tap's guard itself (exact message, top
  frame exactly at the guard's `file:line:column` in this build, connected
  phase, bounded count), and fails on anything else. See "Smoke"
  for what that does and doesn't establish.
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
```

## Verification

Round 7 (2026-10-23, review-panel R3 fix). Gates run in this order, all exit 0:

```
npm run typecheck                               → exit 0
npm run build                                   → exit 0
npx vitest run src/platform                     → exit 0
  Test Files  1 passed (1)
  Tests  18 passed (18)
node --test scripts/smoke-classifier.test.mjs   → exit 0
  ok 1 - findGuardSite locates the single guard Error( in the built assets
  ok 2 - findGuardSite reports `new Error(` at `new`
  ok 3 - findGuardSite fails closed on zero or several candidates
  ok 4 - baseline-shaped errors at the guard site within the bound are tolerated
  ok 5 - same message, same capabilities chunk, different function/location fails
  ok 6 - the same message from an unrelated stack fails
  ok 7 - a guard frame below an unrelated top frame still fails
  ok 8 - no identified guard site means no allowance
  ok 9 - more than the bound fails
  ok 10 - onboarding gets no allowance
  ok 11 - any other message fails
  # tests 11
  # pass 11
  # fail 0
node scripts/smoke.mjs …                        → exit 0 (output below)
```

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

### Smoke: executed, PASSED (bounded render-loop errors at the guard site tolerated)

Scratch gateway (`hermes serve --port 19719` + `hermes gateway run`,
throwaway `HERMES_HOME`, no model provider), production build on `vite
preview`, headless Chromium 155. The smoke:
- attaches one listener per page;
- asserts the connected surface at 1280 **and** 820px;
- checks that the Collapse font loads and that a `<webview>` reports
  "unavailable";
- runs the phone drawer open/close and overflow check.

**Guard site, derived from the build.** Before launching the browser, the
smoke scans the served build's JS assets (`--dist`, default `dist/`) for the
`@assistant-ui/tap` `useSyncExternalStore` guard's throw expression:
`Error(…)` or `new Error(…)` with the exact guard message. It requires
**exactly one** occurrence and records its `file:line:column`, the position
V8 reports for that frame. Node confirms V8 reports `Error(` at `Error` and
`new Error(` at `new`.
- In this build there is one: **`capabilities-B1fqOH3C.js:4:1991`**, the
  `Error(` in `if(++o.current>50)throw o.current=0,Error(...)`. That is
  exactly the top frame of every observed baseline error.
- No source maps are emitted, so the site comes from the minified asset, not
  from a source-mapped origin.
- Zero or several candidates, or a different build being served, means **no
  allowance**: every page error fails (fail closed).

Page errors are judged by `scripts/smoke-classifier.mjs`. An error is
tolerated only if **all** of these hold, and anything else fails the run:
- the message is exactly the guard message;
- the **top stack frame is exactly the guard site** (`file:line:column`), not
  merely somewhere in the same chunk;
- it happens in a connected phase (`tablet`/`phone`). **Onboarding gets no
  allowance.** The phase switches to `tablet` on the main-frame navigation
  that "Save and reconnect" triggers;
- the phase's count is at most **21**, which is 3x the typical baseline of 7
  per phase. Observed counts: 6–7 here, 8–9 in a reviewer's run, 5 in
  upstream Electron.

**What this establishes, and what it doesn't.**
- The upstream Electron comparison shows the original loop is upstream
  behavior.
- The classifier establishes that each tolerated error was **thrown by tap's
  `useSyncExternalStore` guard itself**, with that exact message, on the
  connected surface, within the bound.
- It does **not** identify which tap resource looped. The guard is shared by
  every tap resource using that hook, so a *different* resource looping
  through the same guard, within the bound, would also pass.
- It rejects:
  - the same message thrown from any other location, including other code
    in the same `capabilities-*` chunk;
  - errors whose top frame is elsewhere, even with the guard frame further
    down the stack;
  - onboarding errors and counts above the bound;
  - everything when no unique guard site is found.

  `scripts/smoke-classifier.test.mjs` covers each case. That includes the
  reviewers' scenario: same message, same chunk, different function/location
  (`capabilities-B1fqOH3C.js:32:127`, off-by-one columns, the right location
  in a different file).

Output, verbatim (token redacted):

```
render-loop guard site: capabilities-B1fqOH3C.js:4:1991
screenshot: /tmp/smoke-out/1-onboarding.png
[tablet] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/2-connected-1280.png
screenshot: /tmp/smoke-out/3-connected-tablet-820.png
[phone] console.error: Failed to load resource: the server responded with a status of 409 (Conflict)
screenshot: /tmp/smoke-out/4-connected-phone-390.png
screenshot: /tmp/smoke-out/5-phone-drawer-open.png
[tablet] baseline-shaped render-loop pageerror ×7 (tolerated, bound 21): guard message, top frame exactly at the guard site
[phone] baseline-shaped render-loop pageerror ×7 (tolerated, bound 21): guard message, top frame exactly at the guard site
SMOKE OK: onboarding → connected chat surface (tablet + phone), page errors limited to the bounded baseline render-loop shape, zero bridge errors
exit=0
```

**Fail-closed check, real browser.** The same smoke against the same server,
with `--dist` pointed at an empty directory so no guard site can be found
(excerpt, token redacted):

```
render-loop guard site: NOT identified in this build — no page error will be tolerated
SMOKE FAILED:
[tablet] pageerror: Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop. [no guard site identified in this build: no allowance]
    at http://127.0.0.1:4174/assets/capabilities-B1fqOH3C.js:4:1991
[tablet] pageerror: Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop. [no guard site identified in this build: no allowance]
    at http://127.0.0.1:4174/assets/capabilities-B1fqOH3C.js:4:1991
    … (12 errors, all rejected)
exit=1
```

Earlier rounds (kept for history):
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

**The tablet "Let's get you setup with Hermes Agent / Starting Hermes…"
overlay** is `DesktopOnboardingOverlay` (`src/components/onboarding/index.tsx`).
It renders until `refreshOnboarding` → `checkRuntime` resolves
`$desktopOnboarding.configured`. It shows "Starting Hermes…" while that is
`null` and the provider picker when it is `false`, and it hides when it is
`true`. So the overlay is purely the scratch gateway having no model
provider. Once loaded it showed "Hermes is not connected to any AI provider
yet", and "I'll choose a provider later" dismisses it (the phone step does
that).

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
  resolution. It's upstream behavior, and no port change was made.

