// Android adaptation layer — NOT part of the vendored desktop renderer.
//
// Sign-in to a GATED gateway (`hermes serve` with dashboard.basic_auth or OAuth
// providers: app.state.auth_required). Gated mode ignores the static session
// token; it takes `Authorization: Bearer <access_token>` on REST and
// `?token=<access_token>` on the WebSocket. Tokens come from the gateway's
// RFC 8252 native flow (hermes_cli/dashboard_auth/routes.py + native_flow.py):
//
//   1. GET  {base}/auth/native/authorize?code_challenge=S256(verifier)
//           &code_challenge_method=S256&redirect_uri=http://127.0.0.1/&state=…
//      — the WHOLE WebView navigates there; the user signs in on the gateway's
//      own /login page (or its upstream IdP).
//   2. The gateway finishes at http://127.0.0.1/?code=…&state=…, where nothing
//      listens: MainActivity intercepts that navigation and reloads the app at
//      http://localhost/?oauth-code=…&oauth-state=…
//   3. completeOauthRedirect() (entry, before boot) checks the state against
//      the pending sign-in and POSTs {base}/auth/native/token {code,
//      code_verifier} → {access_token, refresh_token, expires_at, …}.
//   4. A 401 with a refresh token → POST {base}/auth/native/refresh once
//      (single-flight), retry once; 401 session_expired → tokens cleared.
//
// /auth/password-login is NOT used: it answers with HttpOnly cookies only.

import {
  type SavedGateway,
  hostLabel,
  loadGateway,
  normalizeRemoteBaseUrl,
  saveGateway
} from './gateway-config'

export const OAUTH_PENDING_KEY = 'hermes.android.oauth-pending'
export const OAUTH_NOTICE_KEY = 'hermes.android.oauth-notice'
// Canonical loopback (the gateway rejects `localhost`, userinfo, fragments).
// Nothing listens here; the native shell intercepts the navigation.
export const OAUTH_REDIRECT_URI = 'http://127.0.0.1/'
// The gateway's one-time code lives ~120 s; a sign-in left pending far longer
// than a login takes is abandoned.
const PENDING_TTL_MS = 30 * 60 * 1000
const REFRESH_AHEAD_S = 60

interface PendingSignIn {
  baseUrl: string
  verifier: string
  state: string
  createdAt: number
}

interface BearerPayload {
  access_token?: string
  refresh_token?: string
  expires_at?: number
}

export interface OauthNotice {
  kind: 'cancelled' | 'failed'
  message: string
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))

  return b64url(new Uint8Array(digest))
}

// ── Start ────────────────────────────────────────────────────────────────────

/** Persist the pending sign-in and hand the authorize URL to `navigate`
 *  (a whole-page navigation: this page unloads). */
export async function startOauthLogin(remoteUrl: string, navigate: (url: string) => void): Promise<void> {
  const baseUrl = normalizeRemoteBaseUrl(remoteUrl)
  const verifier = randomToken()
  const pending: PendingSignIn = { baseUrl, verifier, state: randomToken(), createdAt: Date.now() }
  const query = new URLSearchParams({
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    redirect_uri: OAUTH_REDIRECT_URI,
    state: pending.state
  })

  localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(pending))
  navigate(`${baseUrl}/auth/native/authorize?${query}`)
}

// ── Complete (runs in entry.ts before the app boots) ────────────────────────

function takePending(): PendingSignIn | null {
  const raw = localStorage.getItem(OAUTH_PENDING_KEY)
  localStorage.removeItem(OAUTH_PENDING_KEY)

  try {
    const pending = JSON.parse(raw || 'null') as PendingSignIn | null

    return pending && typeof pending.state === 'string' && typeof pending.verifier === 'string' ? pending : null
  } catch {
    return null
  }
}

function setNotice(notice: OauthNotice) {
  sessionStorage.setItem(OAUTH_NOTICE_KEY, JSON.stringify(notice))
}

/** The last sign-in's cancellation/failure, shown once. */
export function takeOauthNotice(): OauthNotice | null {
  const raw = sessionStorage.getItem(OAUTH_NOTICE_KEY)
  sessionStorage.removeItem(OAUTH_NOTICE_KEY)

  try {
    return JSON.parse(raw || 'null')
  } catch {
    return null
  }
}

function tokensFrom(payload: BearerPayload): Pick<SavedGateway, 'refreshToken' | 'token' | 'tokenExpiresAt'> | null {
  if (!payload.access_token) {
    return null
  }

  return {
    token: payload.access_token,
    refreshToken: payload.refresh_token || undefined,
    tokenExpiresAt: Number.isFinite(payload.expires_at) ? Number(payload.expires_at) : undefined
  }
}

export type OauthRedirectResult = 'cancelled' | 'failed' | 'none' | 'signed-in'

/**
 * Finish a sign-in the native shell handed back as ?oauth-code=&oauth-state=.
 * Never stores a token unless the state matches the pending sign-in and the
 * gateway redeemed the code. A pending sign-in with no code is a cancellation
 * (the user backed out of the gateway's login page).
 */
export async function completeOauthRedirect(win: Window = window): Promise<OauthRedirectResult> {
  const url = new URL(win.location.href)
  const code = url.searchParams.get('oauth-code')
  const state = url.searchParams.get('oauth-state')
  const hadCallback = url.searchParams.has('oauth-code') || url.searchParams.has('oauth-state')
  const pending = takePending()

  if (hadCallback) {
    url.searchParams.delete('oauth-code')
    url.searchParams.delete('oauth-state')
    win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }

  if (!pending) {
    if (hadCallback) {
      setNotice({ kind: 'failed', message: 'Sign-in failed: no sign-in was in progress. Start it again from Settings → Gateway.' })

      return 'failed'
    }

    return 'none'
  }

  if (!hadCallback) {
    setNotice({ kind: 'cancelled', message: `Sign-in to ${hostLabel(pending.baseUrl)} was cancelled.` })

    return 'cancelled'
  }

  if (!code || !state || state !== pending.state || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    setNotice({ kind: 'failed', message: 'Sign-in failed: the reply did not match the sign-in that was started. Try again.' })

    return 'failed'
  }

  try {
    const res = await fetch(`${pending.baseUrl}/auth/native/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: pending.verifier })
    })
    const tokens = res.ok ? tokensFrom((await res.json()) as BearerPayload) : null

    if (!tokens) {
      throw new Error(res.ok ? 'the gateway returned no access token' : `the gateway answered ${res.status}`)
    }

    const existing = loadGateway()
    const sameEndpoint = existing && normalizeRemoteBaseUrl(existing.httpUrl) === pending.baseUrl

    saveGateway({
      name: (sameEndpoint && existing.name) || hostLabel(pending.baseUrl),
      httpUrl: pending.baseUrl,
      authMode: 'oauth',
      ...tokens
    })

    return 'signed-in'
  } catch (error) {
    setNotice({ kind: 'failed', message: `Sign-in to ${hostLabel(pending.baseUrl)} failed: ${(error as Error).message}.` })

    return 'failed'
  }
}

// ── Refresh ──────────────────────────────────────────────────────────────────

const refreshes = new Map<string, Promise<void>>()

function persistIfSaved(gateway: SavedGateway, previous: { token?: string; refreshToken?: string }) {
  const stored = loadGateway()

  // Only the stored copy of THIS credential — a different gateway may have
  // been saved for the next launch meanwhile.
  if (
    stored &&
    normalizeRemoteBaseUrl(stored.httpUrl) === normalizeRemoteBaseUrl(gateway.httpUrl) &&
    stored.authMode === 'oauth' &&
    (stored.token === previous.token || stored.refreshToken === previous.refreshToken)
  ) {
    saveGateway({ ...stored, token: gateway.token, refreshToken: gateway.refreshToken, tokenExpiresAt: gateway.tokenExpiresAt })
  }
}

/** Rotate the gateway's tokens IN PLACE (the bridge's booted gateway object)
 *  and in storage. Concurrent callers share one request. A rejected refresh
 *  token (401 session_expired) clears the tokens and throws. */
export function refreshOauthTokens(gateway: SavedGateway, baseUrl: string): Promise<void> {
  const refreshToken = gateway.refreshToken

  if (gateway.authMode !== 'oauth' || !refreshToken) {
    return Promise.reject(new Error('No refresh token for this gateway; sign in again.'))
  }

  const inflight = refreshes.get(refreshToken)

  if (inflight) {
    return inflight
  }

  const run = (async () => {
    const previous = { token: gateway.token, refreshToken }
    const res = await fetch(`${baseUrl}/auth/native/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    })

    if (res.status === 401) {
      Object.assign(gateway, { token: undefined, refreshToken: undefined, tokenExpiresAt: undefined })
      persistIfSaved(gateway, previous)

      throw Object.assign(new Error(`401: Signed out of ${hostLabel(baseUrl)} (session expired). Sign in again.`), {
        statusCode: 401
      })
    }

    const tokens = res.ok ? tokensFrom((await res.json()) as BearerPayload) : null

    if (!tokens) {
      throw Object.assign(new Error(`${res.status}: Could not refresh the sign-in for ${hostLabel(baseUrl)}.`), {
        statusCode: res.status || 500
      })
    }

    Object.assign(gateway, { refreshToken: tokens.refreshToken ?? refreshToken, token: tokens.token, tokenExpiresAt: tokens.tokenExpiresAt })
    persistIfSaved(gateway, previous)
  })()

  refreshes.set(refreshToken, run)
  run.then(
    () => refreshes.delete(refreshToken),
    () => refreshes.delete(refreshToken)
  )

  return run
}

/** Before handing out a WebSocket URL: refresh an access token that is about
 *  to expire (the WS leg has no 401-and-retry). Failures leave it as is. */
export async function ensureFreshOauthToken(gateway: SavedGateway, baseUrl: string): Promise<void> {
  if (
    gateway.authMode === 'oauth' &&
    gateway.refreshToken &&
    gateway.tokenExpiresAt &&
    Date.now() / 1000 > gateway.tokenExpiresAt - REFRESH_AHEAD_S
  ) {
    await refreshOauthTokens(gateway, baseUrl).catch(() => {})
  }
}
