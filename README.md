# Hermes Android

A 1:1 port of the [Hermes Agent](https://github.com/NousResearch/hermes-agent) **desktop app** to Android.

- **Tablet**: same layout as the desktop version.
- **Phone**: same layout with minimal adaptations for readability and navigation.

## What this is

The Hermes desktop app (`apps/desktop` in the upstream repo) is an Electron
shell around a Vite/React renderer. The renderer never touches Node/Electron
directly — every native capability arrives through a single typed bridge,
`window.hermesDesktop`, injected by `electron/preload.ts`, and the gateway
conversation itself happens over a plain WebSocket + REST from the renderer.

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
remote connection flow; everything the gateway serves (chat, sessions,
profiles, skills, cron, kanban, settings, messaging) works the same.

## Building

See `app/README.md`.

## Provenance

- Upstream: Hermes Agent by Nous Research, MIT license.
- Vendored snapshot: desktop source `0.21.5` (`desktop-source-0.21.5-f97608f1...`,
  apps/desktop package version `0.17.6`).

## License

MIT — see `LICENSE`. Upstream code © Nous Research; port © Otto Bunge.
