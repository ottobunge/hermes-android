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
// Every OAuth exchange (code redemption, refresh) is bounded, body included.
export const OAUTH_FETCH_TIMEOUT_MS = 30_000

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

/**
 * POST JSON and read the JSON reply under ONE deadline covering headers and
 * body. It races the abort itself, so even a reply that ignores the signal
 * cannot hold the caller past the deadline. Never retried here: a one-time
 * code must not be replayed.
 */
async function exchangeJson(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${OAUTH_FETCH_TIMEOUT_MS / 1000}s`))
    }, OAUTH_FETCH_TIMEOUT_MS)
  })

  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        })
        const data = await res.json().catch(() => null)

        return { status: res.status, data }
      })(),
      deadline
    ])
  } finally {
    clearTimeout(timer)
  }
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
 *  (a whole-page navigation: this page unloads). On Android that is the
 *  native HermesOauth.beginSignIn — see bridge.ts. */
export async function startOauthLogin(
  remoteUrl: string,
  navigate: (url: string, expected: { state: string; redirectUri: string }) => Promise<void> | void
): Promise<void> {
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

  try {
    // Native retains the expected state/redirect and completes only that
    // callback (SignInSession); a browser just navigates.
    await navigate(`${baseUrl}/auth/native/authorize?${query}`, { state: pending.state, redirectUri: OAUTH_REDIRECT_URI })
  } catch (error) {
    localStorage.removeItem(OAUTH_PENDING_KEY)
    throw error
  }
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
    const res = await exchangeJson(`${pending.baseUrl}/auth/native/token`, { code, code_verifier: pending.verifier })
    const ok = res.status >= 200 && res.status < 300
    const tokens = ok ? tokensFrom((res.data ?? {}) as BearerPayload) : null

    if (!tokens) {
      throw new Error(ok ? 'the gateway returned no access token' : `the gateway answered ${res.status}`)
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

// Bumped by sign-out (invalidateOauthSession). A refresh that started before a
// sign-out must not hand its result to anyone afterwards — not to a gateway
// object, not to storage.
let authEpoch = 0

type RefreshOutcome = { kind: 'expired' } | { kind: 'ok'; tokens: Pick<SavedGateway, 'refreshToken' | 'token' | 'tokenExpiresAt'> }

const refreshes = new Map<string, Promise<RefreshOutcome>>()

/** Sign-out: every in-flight or later-completing refresh result is void. */
export function invalidateOauthSession(): void {
  authEpoch++
  refreshes.clear()
}

function signedOutError(baseUrl: string) {
  return Object.assign(new Error(`401: Signed out of ${hostLabel(baseUrl)}. Sign in again.`), { statusCode: 401 })
}

function persistIfSaved(
  baseUrl: string,
  previous: { token?: string; refreshToken: string },
  next: Pick<SavedGateway, 'refreshToken' | 'token' | 'tokenExpiresAt'>
) {
  const stored = loadGateway()

  // Only the stored copy of THIS credential — a different gateway may have
  // been saved for the next launch meanwhile, or the user signed out.
  if (
    stored &&
    normalizeRemoteBaseUrl(stored.httpUrl) === normalizeRemoteBaseUrl(baseUrl) &&
    stored.authMode === 'oauth' &&
    (stored.token === previous.token || stored.refreshToken === previous.refreshToken)
  ) {
    saveGateway({ ...stored, ...next })
  }
}

/** One network refresh per refresh token. Persists its own result (guarded)
 *  BEFORE any caller applies it, so storage is never behind a running client. */
function runRefresh(baseUrl: string, previous: { token?: string; refreshToken: string }, epoch: number) {
  const run = (async (): Promise<RefreshOutcome> => {
    const res = await exchangeJson(`${baseUrl}/auth/native/refresh`, { refresh_token: previous.refreshToken })

    if (res.status === 401) {
      if (epoch === authEpoch) {
        persistIfSaved(baseUrl, previous, { token: undefined, refreshToken: undefined, tokenExpiresAt: undefined })
      }

      return { kind: 'expired' }
    }

    const tokens = res.status >= 200 && res.status < 300 ? tokensFrom((res.data ?? {}) as BearerPayload) : null

    if (!tokens) {
      throw Object.assign(new Error(`${res.status}: Could not refresh the sign-in for ${hostLabel(baseUrl)}.`), {
        statusCode: res.status || 500
      })
    }

    const next = { ...tokens, refreshToken: tokens.refreshToken ?? previous.refreshToken }

    if (epoch === authEpoch) {
      persistIfSaved(baseUrl, previous, next)
    }

    return { kind: 'ok', tokens: next }
  })()

  refreshes.set(previous.refreshToken, run)
  // Released on success, failure or timeout alike (exchangeJson is bounded).
  const release = () => {
    if (refreshes.get(previous.refreshToken) === run) {
      refreshes.delete(previous.refreshToken)
    }
  }
  run.then(release, release)

  return run
}

/**
 * Rotate the gateway's tokens. Concurrent callers share one request, and the
 * result is applied to EVERY caller's gateway object that still holds the
 * pre-refresh refresh token (the booted gateway and fresh loadGateway()
 * copies alike), not just the first. A rejected refresh token (401
 * session_expired) clears them and throws; a sign-out in the meantime voids
 * the result entirely.
 */
export async function refreshOauthTokens(gateway: SavedGateway, baseUrl: string): Promise<void> {
  const refreshToken = gateway.refreshToken

  if (gateway.authMode !== 'oauth' || !refreshToken) {
    throw new Error('No refresh token for this gateway; sign in again.')
  }

  const epoch = authEpoch
  const previous = { token: gateway.token, refreshToken }
  const outcome = await (refreshes.get(refreshToken) ?? runRefresh(baseUrl, previous, epoch))

  if (epoch !== authEpoch) {
    throw signedOutError(baseUrl)
  }

  // Another caller sharing this object may already have applied it.
  if (gateway.refreshToken === refreshToken) {
    Object.assign(
      gateway,
      outcome.kind === 'ok' ? outcome.tokens : { token: undefined, refreshToken: undefined, tokenExpiresAt: undefined }
    )
  }

  if (outcome.kind === 'expired') {
    throw Object.assign(new Error(`401: Signed out of ${hostLabel(baseUrl)} (session expired). Sign in again.`), {
      statusCode: 401
    })
  }
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
