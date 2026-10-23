// Android adaptation layer — NOT part of the vendored desktop renderer.
//
// The saved remote gateway and the pure URL/scope rules Electron main applies
// to it (electron/connection-config.ts). Android cannot spawn the local Python
// backend, so the app is always the desktop's v1 "global remote" client: one
// gateway serves every profile, scoped per request with `?profile=`.

export interface SavedGateway {
  name: string
  httpUrl: string
  /** Token mode: the gateway's static session token (X-Hermes-Session-Token).
   *  OAuth mode: the access token from the native sign-in (Bearer). */
  token?: string
  /** Absent = token mode (every gateway saved before gated-mode support). */
  authMode?: 'oauth' | 'token'
  /** OAuth mode only (oauth.ts). */
  refreshToken?: string
  /** OAuth mode only: access-token expiry, epoch seconds. */
  tokenExpiresAt?: number
}

export const GATEWAY_STORAGE_KEY = 'hermes.android.gateway'

/** Registry id of the one gateway (Electron mints ids; we have exactly one). */
export const GATEWAY_CONNECTION_ID = 'gateway'

export function loadGateway(storage: Storage = localStorage): SavedGateway | null {
  try {
    const raw = JSON.parse(storage.getItem(GATEWAY_STORAGE_KEY) || 'null')

    if (!raw || typeof raw.httpUrl !== 'string' || !raw.httpUrl) {
      return null
    }

    const gateway: SavedGateway = { name: String(raw.name || ''), httpUrl: raw.httpUrl, token: raw.token || undefined }

    if (raw.authMode === 'oauth') {
      gateway.authMode = 'oauth'
      gateway.refreshToken = raw.refreshToken || undefined
      gateway.tokenExpiresAt = Number.isFinite(raw.tokenExpiresAt) ? Number(raw.tokenExpiresAt) : undefined
    }

    return gateway
  } catch {
    return null
  }
}

export function saveGateway(gateway: SavedGateway | null, storage: Storage = localStorage): void {
  if (gateway) {
    storage.setItem(GATEWAY_STORAGE_KEY, JSON.stringify(gateway))
  } else {
    storage.removeItem(GATEWAY_STORAGE_KEY)
  }
}

/** Mirror of electron/connection-config.ts normalizeRemoteBaseUrl. */
export function normalizeRemoteBaseUrl(rawUrl: string): string {
  let value = String(rawUrl || '').trim()

  if (!value) {
    throw new Error('Remote gateway URL is required.')
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`
  }

  let parsed: URL

  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`Remote gateway URL is not valid: ${(error as Error).message}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Remote gateway URL must be http:// or https://, got ${parsed.protocol}`)
  }

  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  return parsed.toString().replace(/\/+$/, '')
}

/**
 * The one rule for editing the saved gateway, shared by every save path
 * (Settings → Gateway and the connections registry). An omitted token keeps
 * the saved one only while the normalized endpoint is unchanged — a new
 * endpoint must bring its own token, so a credential never follows a URL edit
 * to a different host. Android is token-only: an edit that ends without a
 * token is refused rather than saved as an unbootable gateway.
 */
export function resolveGatewayEdit(
  existing: SavedGateway | null,
  edit: { url?: null | string; token?: null | string; name?: null | string }
): SavedGateway {
  const httpUrl = normalizeRemoteBaseUrl(edit.url ?? existing?.httpUrl ?? '')
  const sameEndpoint = Boolean(existing) && normalizeRemoteBaseUrl(existing!.httpUrl) === httpUrl
  const typed = edit.token?.trim()
  const token = typed || (sameEndpoint ? existing!.token : undefined)
  const keepsOauth = !typed && sameEndpoint && existing!.authMode === 'oauth'

  if (!token) {
    throw new Error(
      keepsOauth
        ? `Signed out of ${hostLabel(httpUrl)}. Sign in again from Settings → Gateway.`
        : sameEndpoint
          ? 'A session token is required. Enter the gateway session token.'
          : `Enter the session token for ${hostLabel(httpUrl)} — the saved token belongs to a different gateway.`
    )
  }

  const name = edit.name?.trim() || (sameEndpoint ? existing!.name : '') || hostLabel(httpUrl)

  // Same endpoint, no new token: an OAuth sign-in keeps its tokens. A typed
  // token always means token mode.
  return keepsOauth
    ? { ...existing!, name, httpUrl }
    : { name, httpUrl, token }
}

/** Mirror of electron/connection-config.ts buildGatewayWsUrl (token auth). */
export function buildGatewayWsUrl(baseUrl: string, token: string): string {
  const parsed = new URL(baseUrl)
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')

  return `${wsScheme}://${parsed.host}${prefix}/api/ws?token=${encodeURIComponent(token)}`
}

/** Mirror of electron/connection-config.ts pathWithProfileScope: a shared
 *  remote names the profile on every request unless the path already does. */
export function pathWithProfileScope(path: string, profile?: null | string): string {
  const scoped = String(profile ?? '').trim()

  if (!scoped || !path) {
    return path
  }

  let parsed: URL

  try {
    parsed = new URL(path, 'http://hermes.local')
  } catch {
    return path
  }

  if (parsed.searchParams.has('profile')) {
    return path
  }

  parsed.searchParams.set('profile', scoped)

  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** Mirror of connection-config.ts tokenPreview. */
export function tokenPreview(value?: string): null | string {
  const raw = String(value || '')

  if (!raw) {
    return null
  }

  return raw.length <= 8 ? 'set' : `...${raw.slice(-6)}`
}

export function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
