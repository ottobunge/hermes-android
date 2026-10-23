# Hermes Android

An Android port of the [Hermes Agent](https://github.com/NousResearch/hermes-agent) **desktop renderer**, with the same tablet layout and minimal phone adaptations.

- **Tablet**: same layout as the desktop version.
- **Phone**: same layout with minimal adaptations for readability and navigation.

## What this is

The Hermes desktop app (`apps/desktop` in the upstream repo) is an Electron
shell around a Vite/React renderer. Almost every native
capability reaches the renderer through a single typed bridge,
`window.hermesDesktop`, injected by `electron/preload.ts`, and the gateway
conversation itself happens over a plain WebSocket + REST from the renderer.
The known exception is the Browser/web-preview pane, which hosts pages in
Electron's `<webview>` tag directly. Android has no such tag, so in-app web
previews are unavailable in the port (see `app/README.md`).

This repo ports the app by replacing exactly that seam:

```
upstream/   Pristine vendored copy of the upstream desktop source
            (apps/desktop + apps/shared), kept for diffing/re-vendoring.
app/        The Android port: the same renderer, a web/native implementation
            of the window.hermesDesktop bridge, and a Capacitor Android shell.
```

The Android app connects to a **remote Hermes gateway** (the desktop app's
existing remote-connection mode). Android devices can't spawn the local Python
agent backend, so the local-backend mode of the desktop app is replaced by the
remote connection flow. The renderer screens for what the gateway serves
(chat, sessions, profiles, skills, cron, kanban, settings, messaging) are the
unchanged upstream code. What differs is the native layer: desktop-OS
capabilities (terminal, git, local files, pop-out windows, web previews,
in-app updates) are unavailable or browser equivalents. A debug APK has been
built and exercised on Android phone/tablet emulators; Otto has also confirmed
the app works. `app/README.md` lists each capability and its limits.

## Working checkpoint — 2026-10-23

- Application code: `ffc7c33660dd2f614671fd614e8ef0b46e1b72ba` (round 18).
- Final sign-in review: [APPROVED_WITH_NITS](reviews/arsenal-hermes-android-r18-review-cxsol.md); the prior blocking findings are closed.
- Built debug APK: `app/android/app/build/outputs/apk/debug/app-debug.apk` (24,211,732 bytes).
- APK SHA-256: `7dda7c681c35b2bd2be6034c16e0aaa4d58798d8906f8d79e1bc1391e717d2ce`.
- All 1,071 files in the built web distribution match their APK assets. This is a debug/sideload checkpoint, not a signed store release or a claim that every desktop-only capability exists on Android.
- Development is paused at the owner's request. The known nonblocking null-authorize-URL validation issue remains recorded in the review; no extra feature work is implied by this checkpoint.

## Building

The repository's Nix development shell supplies Node 22, JDK 21, and Android SDK platforms/build-tools 35 and 36:

```sh
nix develop
cd app
npm ci
npm run android:debug
```

See `app/README.md` for the bridge contract, limitations, and verification history.

## Provenance

- Upstream: Hermes Agent by Nous Research, MIT license.
- Vendored snapshot: desktop source `0.21.5` (`desktop-source-0.21.5-f97608f1...`,
  apps/desktop package version `0.17.6`).

## License

MIT — see `LICENSE`. Upstream code © Nous Research; port © Otto Bunge.
