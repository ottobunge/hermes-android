// Android adaptation layer — NOT part of the vendored desktop renderer.
//
// The web/Capacitor implementation of `window.hermesDesktop` — the ONE native
// seam the desktop renderer talks to (src/global.d.ts; Electron's version is
// electron/preload.ts + main.ts). Android cannot run the local Python backend,
// so every route resolves to the single saved remote gateway, exactly as
// Electron's v1 "global remote" mode does. Capabilities that only make sense
// on a desktop OS are either web-equivalents or the safest "unavailable"
// answer; OPTIONAL members the renderer feature-detects are left absent so
// their UI hides itself. See app/README.md "Bridge" for the full list.

import type {
  DesktopConnectionConfig,
  DesktopConnectionConfigInput,
  DesktopConnectionsRegistry,
  DesktopConnectionTestResult,
  DesktopProfileRoute,
  HermesConnection
} from '@/global'

import { POOL_LIMITS_DEFAULTS } from '../../electron/pool-limits'
import { version as appVersion } from '../../package.json'

import { gatewayApi, gatewayHeaders } from './api-transport'
import {
  buildGatewayWsUrl,
  GATEWAY_CONNECTION_ID,
  hostLabel,
  loadGateway,
  normalizeRemoteBaseUrl,
  resolveGatewayEdit,
  type SavedGateway,
  saveGateway,
  tokenPreview
} from './gateway-config'
import { pickFiles, readBlobDataUrl, readBlobText, registerBlob, registerFile } from './local-files'

type Bridge = Window['hermesDesktop']

const UNSUPPORTED = 'Not available on Android.'
const PROFILE_KEY = 'hermes.android.profile'
const DEFAULT_ROUTE_KEY = 'hermes.android.defaultRoute'
const noop = () => {}
const unsubscribe = () => noop
const logs: string[] = []

function log(line: string) {
  logs.push(`${new Date().toISOString()} ${line}\n`)
  logs.splice(0, Math.max(0, logs.length - 200))
}

function unsupported(): Promise<never> {
  return Promise.reject(new Error(UNSUPPORTED))
}

// The gateway this page booted with. REST and the WebSocket both resolve from
// it, so a save can never split them across two servers: a saved change takes
// effect only through a reload (applyAndReload) — the page IS the client.
let activeGateway: SavedGateway | null | undefined

function bootGateway(): SavedGateway | null {
  if (activeGateway === undefined) {
    activeGateway = loadGateway()
  }

  return activeGateway
}

/** Test seam: forget the booted gateway so the next call re-reads storage. */
export function resetActiveGatewayForTests(): void {
  activeGateway = undefined
}

function requireGateway(): SavedGateway {
  const gateway = bootGateway()

  if (!gateway) {
    throw new Error('No Hermes gateway is configured. Open Settings → Gateway to connect one.')
  }

  if (!gateway.token) {
    // Same wording as Electron's buildRemoteConnection.
    throw new Error(
      'Remote Hermes gateway is selected, but no session token is saved. Open Settings → Gateway and save a token.'
    )
  }

  return gateway
}

async function fetchStatus(baseUrl: string, gateway?: SavedGateway, timeoutMs = 8_000): Promise<any> {
  return gatewayApi(gateway ?? { name: '', httpUrl: baseUrl }, { path: '/api/status', timeoutMs }, baseUrl)
}

let remoteVersion = ''

/** Electron ensureBackend → buildRemoteConnection + waitForHermes, v1 global remote. */
async function connect(profile?: null | string): Promise<HermesConnection> {
  const gateway = requireGateway()
  const baseUrl = normalizeRemoteBaseUrl(gateway.httpUrl)
  const status = await fetchStatus(baseUrl, gateway, 10_000)
  remoteVersion = String(status?.version || remoteVersion || '')

  return {
    baseUrl,
    mode: 'remote',
    source: 'settings',
    authMode: 'token',
    remoteHost: hostLabel(baseUrl),
    remoteKind: 'url',
    remoteHermesVersion: remoteVersion || undefined,
    token: gateway.token!,
    wsUrl: buildGatewayWsUrl(baseUrl, gateway.token!),
    logs: logs.slice(-80),
    isFullscreen: false,
    isMaximized: true,
    nativeOverlayWidth: 0,
    windowButtonPosition: null,
    darwinMajor: 0,
    // One host serves every profile: the descriptor carries the request scope.
    profile: String(profile ?? '').trim() || 'default',
    sharedPrimary: true,
    connectionId: GATEWAY_CONNECTION_ID
  }
}

function wsUrlResult() {
  try {
    const gateway = requireGateway()

    return { ok: true as const, wsUrl: buildGatewayWsUrl(normalizeRemoteBaseUrl(gateway.httpUrl), gateway.token!) }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
}

function connectionConfig(): DesktopConnectionConfig {
  const gateway = loadGateway()

  return {
    envOverride: false,
    mode: 'remote',
    profile: null,
    remoteAuthMode: 'token',
    remoteOauthConnected: false,
    remoteTokenPreview: tokenPreview(gateway?.token),
    remoteTokenSet: Boolean(gateway?.token),
    // The token lives in the WebView's localStorage inside the app's private
    // per-UID sandbox — the Android analogue of the OS keychain gate. Not
    // Keystore-encrypted; see README "Known gaps".
    secureTokenStorage: true,
    remoteTokenPlainText: false,
    remoteUrl: gateway?.httpUrl ?? '',
    cloudOrg: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshKeyPath: '',
    sshRemoteHermesPath: '',
    sshRemoteProfile: ''
  }
}

function assertRemote(input: DesktopConnectionConfigInput) {
  if (input.mode !== 'remote') {
    throw new Error('Android connects to a remote Hermes gateway only — choose "Remote gateway".')
  }

  if (input.remoteAuthMode === 'oauth') {
    throw new Error('OAuth-gated gateways are not supported on Android yet — use a session token.')
  }
}

function coerce(input: DesktopConnectionConfigInput): SavedGateway {
  assertRemote(input)

  return resolveGatewayEdit(loadGateway(), { url: input.remoteUrl, token: input.remoteToken })
}

/** Mirrors Electron's test: /api/status, then the token on a guarded route
 *  and the live /api/ws leg. /api/status is public, so reachability alone
 *  never certifies a usable connection — no token, no success. */
async function testGateway(gateway: SavedGateway): Promise<DesktopConnectionTestResult> {
  const baseUrl = normalizeRemoteBaseUrl(gateway.httpUrl)

  try {
    if (!gateway.token) {
      throw new Error('A session token is required to connect to this gateway.')
    }

    const status = await fetchStatus(baseUrl, gateway)
    await gatewayApi(gateway, { path: '/api/sessions?limit=1', timeoutMs: 8_000 }, baseUrl)
    await probeWebSocket(buildGatewayWsUrl(baseUrl, gateway.token))

    return { ok: true, reachable: true, baseUrl, version: status?.version || null }
  } catch (error) {
    return { ok: false, reachable: false, baseUrl, error: (error as Error).message }
  }
}

function probeWebSocket(url: string, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)

    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('Reached the gateway over HTTP, but the live WebSocket (/api/ws) timed out.'))
    }, timeoutMs)

    ws.onopen = () => {
      clearTimeout(timer)
      ws.close()
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      ws.close()
      reject(new Error('Reached the gateway over HTTP, but the live WebSocket (/api/ws) connection failed.'))
    }
  })
}

function registry(): DesktopConnectionsRegistry {
  const gateway = loadGateway()

  return {
    version: 2,
    primary: GATEWAY_CONNECTION_ID,
    secureTokenStorage: true,
    connections: gateway
      ? [
          {
            id: GATEWAY_CONNECTION_ID,
            kind: 'remote',
            label: gateway.name || hostLabel(gateway.httpUrl),
            url: gateway.httpUrl,
            authMode: 'token',
            tokenSet: Boolean(gateway.token),
            tokenPreview: tokenPreview(gateway.token)
          }
        ]
      : []
  }
}

// Applying a new gateway is a hard re-home here (window reload) rather than
// Electron's soft in-place re-dial — the whole page IS the backend client.
async function testAndReload(gateway: SavedGateway) {
  const result = await testGateway(gateway)

  if (!result.ok) {
    throw new Error(result.error || 'Could not connect to the Hermes gateway.')
  }

  applyAndReload(gateway)
}

/** Page lifecycle seam (jsdom's location.reload can't be spied on). */
export const pageLifecycle = { reload: () => window.location.reload() }

function applyAndReload(gateway: SavedGateway) {
  saveGateway(gateway)
  setTimeout(() => pageLifecycle.reload(), 400)
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) || 'null') as T) ?? fallback
  } catch {
    return fallback
  }
}

async function notify(payload: { title?: string; body?: string; silent?: boolean; tag?: string }): Promise<boolean> {
  if (typeof Notification === 'undefined') {
    return false
  }

  if (Notification.permission === 'default') {
    await Notification.requestPermission().catch(() => 'denied')
  }

  if (Notification.permission !== 'granted') {
    return false
  }

  new Notification(payload.title || 'Hermes', { body: payload.body, silent: payload.silent, tag: payload.tag })

  return true
}

async function clipboardImagePath(): Promise<string> {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => t.startsWith('image/'))

      if (type) {
        return registerBlob(await item.getType(type), `clipboard.${type.split('/')[1] || 'png'}`)
      }
    }
  } catch {
    // Clipboard read denied/unsupported → no image.
  }

  return ''
}

function downloadUrl(url: string, name = 'image') {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export const bridge: Bridge = {
  glassSupported: false,
  translucencySupported: false,
  localModelsEnabled: false,
  guestOnboardingEnabled: false,
  skipIntro: true,

  // ── Connection (the core of the port) ─────────────────────────────────────
  getConnection: profile => connect(profile),
  getConnectionFor: async payload => ({
    ...(await connect(payload?.profile)),
    sharedPrimary: undefined,
    sharedRemote: true,
    registryScoped: true
  }),
  getGatewayWsUrl: async () => wsUrlResult(),
  getGatewayWsUrlFor: async () => wsUrlResult(),
  revalidateConnection: async () => {
    const gateway = bootGateway()

    if (!gateway) {
      return { ok: false, rebuilt: false }
    }

    try {
      await fetchStatus(normalizeRemoteBaseUrl(gateway.httpUrl), gateway)

      return { ok: true, rebuilt: false }
    } catch (error) {
      log(`[revalidate] ${(error as Error).message}`)

      return { ok: false, rebuilt: true }
    }
  },
  touchBackend: async () => ({ ok: true }),
  getProfileRoutes: async profiles =>
    profiles.map(profile => ({ connectionId: GATEWAY_CONNECTION_ID, mode: 'remote', profile, targetProfile: profile })),
  getPoolLimits: async () => ({ ...POOL_LIMITS_DEFAULTS }),
  setPoolLimits: async () => ({ ok: true, limits: { ...POOL_LIMITS_DEFAULTS } }),
  api: request => {
    const gateway = requireGateway()

    return gatewayApi(gateway, request, normalizeRemoteBaseUrl(gateway.httpUrl))
  },

  // ── Connection settings (drives the reused Settings → Gateway panel) ──────
  getConnectionConfig: async () => connectionConfig(),
  // Persists for the next boot; the running page keeps its booted gateway.
  saveConnectionConfig: async input => {
    saveGateway(coerce(input))

    return connectionConfig()
  },
  applyConnectionConfig: async input => {
    await testAndReload(coerce(input))

    return connectionConfig()
  },
  testConnectionConfig: async input => {
    let gateway: SavedGateway

    try {
      gateway = coerce(input)
    } catch (error) {
      return { ok: false, reachable: false, baseUrl: input.remoteUrl ?? '', error: (error as Error).message }
    }

    return testGateway(gateway)
  },
  probeConnectionConfig: async remoteUrl => {
    const baseUrl = normalizeRemoteBaseUrl(remoteUrl)

    try {
      const status = await fetchStatus(baseUrl)

      return {
        baseUrl,
        reachable: true,
        authMode: status?.auth_required ? 'oauth' : 'token',
        providers: [],
        version: status?.version || null,
        error: null
      }
    } catch (error) {
      return { baseUrl, reachable: false, authMode: 'unknown', providers: [], version: null, error: (error as Error).message }
    }
  },
  oauthLoginConnectionConfig: () => unsupported(),
  oauthLogoutConnectionConfig: async () => ({ ok: true, connected: false }),
  getSecretStorageEncryption: async () => ({ on: false }),
  setSecretStorageEncryption: () => unsupported(),
  sshConfigHosts: async () => ({ hosts: [] }),
  sshResolveHost: async () => ({ hostname: null, identityFile: null, port: null, user: null }),
  connections: {
    list: async () => registry(),
    save: async input => {
      if (input.kind !== 'remote' || (input.id && input.id !== GATEWAY_CONNECTION_ID)) {
        throw new Error('Android supports one remote gateway — edit it in Settings → Gateway.')
      }

      const current = loadGateway()
      const next = resolveGatewayEdit(current, { url: input.url, token: input.token, name: input.label })
      const material = !current || next.httpUrl !== normalizeRemoteBaseUrl(current.httpUrl) || next.token !== current.token

      if (material) {
        // Endpoint or credential changed: same validate → save → reload as
        // Settings → Gateway, so REST and the live socket move together.
        await testAndReload(next)
      } else {
        saveGateway(next)
      }

      const reg = registry()

      return { ok: true, connection: reg.connections[0], registry: reg }
    },
    remove: () => unsupported(),
    setPrimary: async () => ({ ok: true, registry: registry() }),
    // Diagnoses the SAVED row the registry lists — which may differ from the
    // gateway this page booted with (Settings → "Save for next restart").
    test: async () => {
      const saved = loadGateway()

      return saved
        ? testGateway(saved)
        : { ok: false, reachable: false, baseUrl: '', error: 'No Hermes gateway is configured.' }
    }
  },
  cloud: {
    status: async () => ({ portalBaseUrl: 'https://portal.nousresearch.com', signedIn: false }),
    login: () => unsupported(),
    logout: async () => ({ ok: true, portalBaseUrl: 'https://portal.nousresearch.com', signedIn: false }),
    discover: () => unsupported(),
    agentSignIn: () => unsupported()
  },
  profile: {
    getDefault: async () => readJson<DesktopProfileRoute | null>(DEFAULT_ROUTE_KEY, null),
    setDefault: async route => {
      localStorage.setItem(DEFAULT_ROUTE_KEY, JSON.stringify(route))

      return route
    },
    onDefaultChanged: unsubscribe,
    get: async () => ({ profile: localStorage.getItem(PROFILE_KEY) }),
    remember: async name => {
      if (name) {
        localStorage.setItem(PROFILE_KEY, name)
      }

      return { profile: localStorage.getItem(PROFILE_KEY) }
    },
    set: async name => {
      if (name) {
        localStorage.setItem(PROFILE_KEY, name)
      } else {
        localStorage.removeItem(PROFILE_KEY)
      }

      return { profile: name }
    }
  },

  // ── Boot / bootstrap: nothing to install on Android ───────────────────────
  getBootProgress: async () => ({
    error: null,
    fakeMode: false,
    message: '',
    phase: 'ready',
    progress: 100,
    running: false,
    timestamp: Date.now()
  }),
  onBootProgress: unsubscribe,
  getBootstrapState: async () => ({
    active: false,
    manifest: null,
    stages: {},
    error: null,
    log: [],
    startedAt: null,
    completedAt: null,
    setupChoice: null,
    unsupportedPlatform: null
  }),
  continueBootstrapLocal: async () => ({ ok: true }),
  resetBootstrap: async () => ({ ok: true }),
  repairBootstrap: async () => ({ ok: true }),
  cancelBootstrap: async () => ({ ok: true, cancelled: false }),
  onBootstrapEvent: unsubscribe,
  onBackendExit: unsubscribe,
  getVersion: async () => ({
    appVersion,
    electronVersion: '',
    nodeVersion: '',
    platform: 'android',
    hermesRoot: ''
  }),
  updates: {
    check: async () => ({ supported: false, reason: 'android', message: 'Update the Android app from its store.' }),
    apply: async () => ({ ok: false, error: UNSUPPORTED }),
    getBranch: async () => ({ branch: '' }),
    setBranch: async () => ({ branch: '' }),
    onProgress: unsubscribe
  },
  uninstall: {
    summary: async () => ({
      hermes_home: '',
      agent_installed: false,
      gui_installed: true,
      source_built_artifacts: [],
      packaged_app_paths: [],
      userdata_dir: '',
      userdata_exists: false,
      platform: 'android'
    }),
    run: async () => ({ ok: false, error: UNSUPPORTED })
  },

  // ── Web equivalents ───────────────────────────────────────────────────────
  notify,
  requestMicrophoneAccess: async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => track.stop())

      return true
    } catch {
      return false
    }
  },
  writeClipboard: async text => {
    try {
      await navigator.clipboard.writeText(text)

      return true
    } catch {
      return false
    }
  },
  readClipboard: async () => navigator.clipboard.readText().catch(() => ''),
  openExternal: async url => {
    window.open(url, '_blank', 'noopener')
  },
  selectPaths: options => pickFiles(options),
  getPathForFile: file => registerFile(file),
  readFileDataUrl: path => readBlobDataUrl(path),
  readFileText: path => readBlobText(path),
  saveImageBuffer: async (data, ext, name) =>
    registerBlob(new Blob([data as BlobPart]), `${name || 'image'}.${String(ext).replace(/^\./, '')}`),
  savePastedText: async text => registerBlob(new Blob([text], { type: 'text/plain' }), 'pasted.txt'),
  saveClipboardImage: clipboardImagePath,
  saveImageFromUrl: async url => {
    try {
      downloadUrl(url)

      return true
    } catch {
      return false
    }
  },
  claimAmbientCue: async () => true,
  // No native preview classification: there is no Electron <webview> guest
  // on Android (see webview-unavailable.ts), so nothing is advertised here.
  normalizePreviewTarget: async () => null,

  // ── Desktop-OS capabilities: unavailable answers ──────────────────────────
  openSessionWindow: async () => ({ ok: false, error: UNSUPPORTED }),
  openSessionInTerminal: async () => ({ ok: false, error: UNSUPPORTED }),
  openWindow: async () => ({ ok: false, error: UNSUPPORTED }),
  openBrowserWindow: async () => ({ ok: false, error: UNSUPPORTED }),
  onBrowserPopoutClosed: unsubscribe,
  windowControls: { custom: false, minimize: noop, toggleMaximize: noop, close: noop },
  petOverlay: {
    open: async () => ({ ok: false }),
    close: async () => ({ ok: true }),
    setBounds: noop,
    setIgnoreMouse: noop,
    setFocusable: noop,
    pushState: noop,
    control: noop,
    onState: unsubscribe,
    onControl: unsubscribe
  },
  quickEntry: {
    getSettings: async () => ({ enabled: false, error: null, registered: false, shortcut: '' }),
    setSettings: async () => ({ enabled: false, error: null, registered: false, shortcut: '' }),
    submit: noop,
    dismiss: noop,
    pushState: noop,
    onState: unsubscribe,
    onSubmit: unsubscribe,
    onShown: unsubscribe
  },
  watchPreviewFile: () => unsupported(),
  stopPreviewFileWatch: async () => true,
  onPreviewFileChanged: unsubscribe,
  fetchLinkTitle: async () => '',
  sanitizeWorkspaceCwd: async cwd => ({ cwd: cwd || '', sanitized: false }),
  settings: {
    getDefaultProjectDir: async () => ({ defaultLabel: '', dir: null, resolvedCwd: '' }),
    pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
    setDefaultProjectDir: async dir => ({ dir })
  },
  revealLogs: async () => ({ ok: false, path: '', error: UNSUPPORTED }),
  getRecentLogs: async () => ({ path: '', lines: logs.slice(-80) }),
  readDir: async () => ({ entries: [], error: UNSUPPORTED }),
  terminal: {
    attach: async () => false,
    cwd: async () => null,
    dispose: async () => true,
    onData: unsubscribe,
    onExit: unsubscribe,
    resize: async () => false,
    start: () => unsupported(),
    write: async () => false
  },
  themes: {
    fetchMarketplace: () => unsupported(),
    searchMarketplace: async () => []
  },
  findInPage: async () => ({ count: 0 }),
  stopFindInPage: async () => {},
  onFoundInPage: unsubscribe,
  onOpenFindBarRequested: unsubscribe
}

export function installBridge(): void {
  if (!window.hermesDesktop) {
    window.hermesDesktop = bridge
  }
}
