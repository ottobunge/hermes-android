// Gated-gateway sign-in (oauth.ts) and the transport/bridge seams that use it.
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { gatewayApi, gatewayHeaders } from './api-transport'
import { bridge, pageLifecycle, resetActiveGatewayForTests } from './bridge'
import { GATEWAY_STORAGE_KEY, loadGateway, type SavedGateway, saveGateway } from './gateway-config'
import {
  completeOauthRedirect,
  OAUTH_PENDING_KEY,
  OAUTH_REDIRECT_URI,
  refreshOauthTokens,
  startOauthLogin,
  takeOauthNotice
} from './oauth'

const BASE = 'https://gw.example'
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const oauthGateway = (extra: Partial<SavedGateway> = {}): SavedGateway => ({
  name: 'gw',
  httpUrl: BASE,
  authMode: 'oauth',
  token: 'access-1',
  refreshToken: 'refresh-1',
  tokenExpiresAt: 2_000_000_000,
  ...extra
})

const headerOf = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name]

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  history.replaceState(null, '', '/')
  resetActiveGatewayForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A fetch double whose /auth/native/refresh reply is held until release(). */
function heldRefresh(authorizedBearer = 'Bearer access-2') {
  let release!: (response: Response) => void
  let started!: () => void
  const refreshStarted = new Promise<void>(resolve => (started = resolve))
  const seen: string[] = []

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/native/refresh')) {
      started()

      return new Promise<Response>(resolve => (release = resolve))
    }

    if (url.endsWith('/auth/logout')) {
      return json(200, {})
    }

    const bearer = headerOf(init, 'Authorization') ?? ''
    seen.push(bearer)

    return bearer === authorizedBearer ? json(200, { ok: true }) : json(401, { detail: 'Unauthorized' })
  })

  vi.stubGlobal('fetch', fetchMock)

  return { fetchMock, refreshStarted, release: (response: Response) => release(response), seen }
}

describe('transport auth header', () => {
  it('sends Bearer for oauth gateways and the session token otherwise — never both', async () => {
    expect(gatewayHeaders(oauthGateway())).toEqual({ Authorization: 'Bearer access-1' })
    expect(gatewayHeaders({ name: 'gw', httpUrl: BASE, token: 'tok' })).toEqual({ 'X-Hermes-Session-Token': 'tok' })
    expect(gatewayHeaders({ name: 'gw', httpUrl: BASE, authMode: 'oauth' })).toEqual({})

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    await gatewayApi(oauthGateway(), { path: '/api/config' }, BASE)
    const [, init] = fetchMock.mock.calls[0]

    expect(headerOf(init, 'Authorization')).toBe('Bearer access-1')
    expect(headerOf(init, 'X-Hermes-Session-Token')).toBeUndefined()
  })
})

describe('401 refresh leg', () => {
  // Gateway double: Bearer access-1 → 401; refresh-1 → access-2/refresh-2;
  // Bearer access-2 → 200 (unless `stillRejected`).
  function gatewayDouble({ stillRejected = false, refreshStatus = 200 } = {}) {
    const refreshCalls: unknown[] = []

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/native/refresh')) {
        refreshCalls.push(JSON.parse(String(init?.body)))
        await new Promise(resolve => setTimeout(resolve, 20))

        return refreshStatus === 200
          ? json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_at: 2_000_000_100 })
          : json(refreshStatus, { error: 'session_expired' })
      }

      const bearer = headerOf(init, 'Authorization')

      return bearer === 'Bearer access-2' && !stillRejected ? json(200, { ok: url }) : json(401, { detail: 'Unauthorized' })
    })

    vi.stubGlobal('fetch', fetchMock)

    return { fetchMock, refreshCalls }
  }

  it('concurrent 401s share ONE refresh, then each request is retried once with the new token', async () => {
    const gateway = oauthGateway()
    saveGateway(gateway)
    const { refreshCalls } = gatewayDouble()

    const [a, b] = await Promise.all([
      gatewayApi(gateway, { path: '/api/a' }, BASE),
      gatewayApi(gateway, { path: '/api/b' }, BASE)
    ])

    expect(a).toEqual({ ok: `${BASE}/api/a` })
    expect(b).toEqual({ ok: `${BASE}/api/b` })
    expect(refreshCalls).toEqual([{ refresh_token: 'refresh-1' }])
    expect(gateway).toMatchObject({ token: 'access-2', refreshToken: 'refresh-2', tokenExpiresAt: 2_000_000_100 })
    expect(loadGateway()).toMatchObject({ authMode: 'oauth', token: 'access-2', refreshToken: 'refresh-2' })
  })

  it('retries only once: a 401 after the refresh is returned, without a second refresh', async () => {
    const gateway = oauthGateway()
    const { fetchMock, refreshCalls } = gatewayDouble({ stillRejected: true })

    await expect(gatewayApi(gateway, { path: '/api/a' }, BASE)).rejects.toMatchObject({ statusCode: 401 })
    expect(refreshCalls).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3) // request, refresh, one retry
  })

  it('session_expired clears the tokens (memory and storage) and fails the request', async () => {
    const gateway = oauthGateway()
    saveGateway(gateway)
    gatewayDouble({ refreshStatus: 401 })

    await expect(gatewayApi(gateway, { path: '/api/a' }, BASE)).rejects.toThrow(/session expired/)
    expect(gateway).toMatchObject({ token: undefined, refreshToken: undefined, tokenExpiresAt: undefined })
    expect(loadGateway()).toEqual({ name: 'gw', httpUrl: BASE, authMode: 'oauth', token: undefined, refreshToken: undefined, tokenExpiresAt: undefined })
  })

  it('token-mode gateways never refresh', async () => {
    const fetchMock = vi.fn(async () => json(401, { detail: 'Unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(gatewayApi({ name: 'gw', httpUrl: BASE, token: 'tok' }, { path: '/api/a' }, BASE)).rejects.toMatchObject({
      statusCode: 401
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not refresh without a refresh token', async () => {
    await expect(refreshOauthTokens(oauthGateway({ refreshToken: undefined }), BASE)).rejects.toThrow(/sign in again/i)
  })
})

describe('starting a sign-in', () => {
  it('persists PKCE + state and navigates to the native authorize URL', async () => {
    const navigate = vi.fn()
    await startOauthLogin(`${BASE}/`, navigate)

    const pending = JSON.parse(localStorage.getItem(OAUTH_PENDING_KEY)!)
    const url = new URL(navigate.mock.calls[0][0])

    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/auth/native/authorize`)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH_REDIRECT_URI)
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(pending.baseUrl).toBe(BASE)
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(pending.verifier).digest('base64url'))
    // Native binds the callback to exactly this state and redirect (SignInSession).
    expect(navigate.mock.calls[0][1]).toEqual({ state: pending.state, redirectUri: OAUTH_REDIRECT_URI })
  })
})

describe('finishing a sign-in (?oauth-code=&oauth-state=)', () => {
  function pending(extra: Record<string, unknown> = {}) {
    localStorage.setItem(
      OAUTH_PENDING_KEY,
      JSON.stringify({ baseUrl: BASE, verifier: 'verifier-1', state: 'state-1', createdAt: Date.now(), ...extra })
    )
  }

  it('redeems the code with the verifier and saves an oauth gateway; cleans the URL', async () => {
    pending()
    history.replaceState(null, '', '/?oauth-code=code-1&oauth-state=state-1')
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_at: 1792798866 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(completeOauthRedirect()).resolves.toBe('signed-in')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/auth/native/token`)
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'code-1', code_verifier: 'verifier-1' })
    expect(loadGateway()).toEqual({
      name: 'gw.example',
      httpUrl: BASE,
      authMode: 'oauth',
      token: 'access-1',
      refreshToken: 'refresh-1',
      tokenExpiresAt: 1792798866
    })
    expect(location.search).toBe('')
    expect(localStorage.getItem(OAUTH_PENDING_KEY)).toBeNull()
  })

  it('a bogus code (400) stores nothing and reports the failure', async () => {
    pending()
    history.replaceState(null, '', '/?oauth-code=bogus&oauth-state=state-1')
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { detail: 'Invalid or expired authorization code.' })))

    await expect(completeOauthRedirect()).resolves.toBe('failed')
    expect(localStorage.getItem(GATEWAY_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(OAUTH_PENDING_KEY)).toBeNull()
    expect(takeOauthNotice()).toMatchObject({ kind: 'failed', message: expect.stringMatching(/400/) })
  })

  it('a state mismatch never contacts the gateway and never stores a token', async () => {
    pending()
    history.replaceState(null, '', '/?oauth-code=code-1&oauth-state=someone-else')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(completeOauthRedirect()).resolves.toBe('failed')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(GATEWAY_STORAGE_KEY)).toBeNull()
    expect(takeOauthNotice()?.kind).toBe('failed')
  })

  it('a callback with no pending sign-in stores nothing', async () => {
    history.replaceState(null, '', '/?oauth-code=code-1&oauth-state=state-1')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(completeOauthRedirect()).resolves.toBe('failed')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(GATEWAY_STORAGE_KEY)).toBeNull()
  })

  it('a pending sign-in with no code is a cancellation (Back out of the login page)', async () => {
    pending()

    await expect(completeOauthRedirect()).resolves.toBe('cancelled')
    expect(localStorage.getItem(OAUTH_PENDING_KEY)).toBeNull()
    expect(takeOauthNotice()).toEqual({ kind: 'cancelled', message: 'Sign-in to gw.example was cancelled.' })
  })

  it('no callback and nothing pending is an ordinary boot', async () => {
    await expect(completeOauthRedirect()).resolves.toBe('none')
    expect(takeOauthNotice()).toBeNull()
  })
})

describe('bridge in gated mode', () => {
  it('probe reports oauth + the public provider list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/status')
          ? json(200, { version: '9', auth_required: true })
          : json(200, { providers: [{ name: 'basic', display_name: 'Username & Password', supports_password: true }] })
      )
    )

    await expect(bridge.probeConnectionConfig(BASE)).resolves.toEqual({
      baseUrl: BASE,
      reachable: true,
      authMode: 'oauth',
      providers: [{ name: 'basic', displayName: 'Username & Password', supportsPassword: true }],
      version: '9',
      error: null
    })
  })

  it('reports a saved sign-in as oauth-connected, and the not-yet-signed-in oauth save is a no-op', async () => {
    await expect(
      bridge.saveConnectionConfig({ mode: 'remote', remoteAuthMode: 'oauth', remoteUrl: BASE })
    ).resolves.toMatchObject({ remoteOauthConnected: false })
    expect(loadGateway()).toBeNull()

    saveGateway(oauthGateway())
    await expect(bridge.getConnectionConfig(null)).resolves.toMatchObject({
      remoteAuthMode: 'oauth',
      remoteOauthConnected: true,
      remoteTokenSet: false,
      remoteTokenPreview: null
    })
  })

  it('login hands the authorize URL to the page and never settles (the page unloads)', async () => {
    const navigate = vi.spyOn(pageLifecycle, 'navigate').mockImplementation(() => {})
    let settled = false
    void bridge.oauthLoginConnectionConfig(BASE).then(() => (settled = true))
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(navigate.mock.calls[0][0]).toMatch(/^https:\/\/gw\.example\/auth\/native\/authorize\?/)
    expect(settled).toBe(false)
  })

  it('logout clears the sign-in, tells the gateway with Bearer, then reloads the page', async () => {
    vi.useFakeTimers()
    const reload = vi.spyOn(pageLifecycle, 'reload').mockImplementation(() => {})
    saveGateway(oauthGateway())
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(bridge.oauthLogoutConnectionConfig(BASE)).resolves.toEqual({ ok: true, connected: false })
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/auth/logout`)
    expect(headerOf(fetchMock.mock.calls[0][1], 'Authorization')).toBe('Bearer access-1')
    expect(loadGateway()).toMatchObject({ authMode: 'oauth', token: undefined, refreshToken: undefined })
    await expect(bridge.getConnectionConfig(null)).resolves.toMatchObject({ remoteOauthConnected: false })
    // Persisted first (above), THEN the reload that ends every live socket.
    expect(reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a gated gateway connects with the access token on REST and the WebSocket', async () => {
    saveGateway(oauthGateway())
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { version: '9' }))
    vi.stubGlobal('fetch', fetchMock)

    const conn = await bridge.getConnection()

    expect(conn).toMatchObject({ authMode: 'oauth', token: 'access-1', wsUrl: 'wss://gw.example/api/ws?token=access-1' })
    expect(headerOf(fetchMock.mock.calls[0][1], 'Authorization')).toBe('Bearer access-1')
  })
})

describe('round 17: refresh ownership, logout races, bounded exchanges', () => {
  it('a shared refresh reaches EVERY caller holding the same credential, not just the first object', async () => {
    const first = oauthGateway()
    const second = oauthGateway() // e.g. a fresh loadGateway() copy
    const held = heldRefresh()

    const results = Promise.allSettled([
      gatewayApi(first, { path: '/api/a' }, BASE),
      gatewayApi(second, { path: '/api/b' }, BASE)
    ])
    await held.refreshStarted
    await new Promise(resolve => setTimeout(resolve, 0))
    held.release(json(200, { access_token: 'access-2', refresh_token: 'refresh-2' }))

    expect((await results).map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect([first.token, second.token]).toEqual(['access-2', 'access-2'])
    expect([first.refreshToken, second.refreshToken]).toEqual(['refresh-2', 'refresh-2'])
    expect(held.fetchMock.mock.calls.filter(([url]) => url.endsWith('/auth/native/refresh'))).toHaveLength(1)
  })

  it('an expired refresh signs out every caller holding that credential', async () => {
    const first = oauthGateway()
    const second = oauthGateway()
    const held = heldRefresh()

    const results = Promise.allSettled([
      gatewayApi(first, { path: '/api/a' }, BASE),
      gatewayApi(second, { path: '/api/b' }, BASE)
    ])
    await held.refreshStarted
    await new Promise(resolve => setTimeout(resolve, 0))
    held.release(json(401, { error: 'session_expired' }))

    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect([first.token, second.token, first.refreshToken, second.refreshToken]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })

  it('logout during a refresh voids its late success: no token comes back, in memory or storage', async () => {
    vi.spyOn(pageLifecycle, 'reload').mockImplementation(() => {})
    saveGateway(oauthGateway())
    const held = heldRefresh()

    const request = bridge.api({ path: '/api/config' })
    await held.refreshStarted
    await bridge.oauthLogoutConnectionConfig(BASE)
    held.release(json(200, { access_token: 'access-2', refresh_token: 'refresh-2' }))

    await expect(request).rejects.toThrow(/Signed out/)
    // Signed out: bridge.api refuses up front (requireGateway throws on call).
    await expect((async () => bridge.api({ path: '/api/config' }))()).rejects.toThrow(/Signed out/)
    expect(held.seen).not.toContain('Bearer access-2')
    expect(loadGateway()).toMatchObject({ token: undefined, refreshToken: undefined })
  })

  it('a stalled code exchange gives up after 30 s with a visible failure — the code is never replayed', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      OAUTH_PENDING_KEY,
      JSON.stringify({ baseUrl: BASE, verifier: 'v', state: 's', createdAt: Date.now() })
    )
    history.replaceState(null, '', '/?oauth-code=c&oauth-state=s')
    // Never answers, and ignores the abort signal: the deadline must still win.
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    let result: string | undefined
    void completeOauthRedirect().then(value => (result = value))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_500)

    expect(result).toBe('failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(takeOauthNotice()).toMatchObject({ kind: 'failed', message: expect.stringMatching(/timed out after 30s/) })
    expect(localStorage.getItem(GATEWAY_STORAGE_KEY)).toBeNull()
  })

  it('a stalled refresh fails the request after 30 s and releases the single-flight entry', async () => {
    vi.useFakeTimers()
    const refreshCalls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/native/refresh')) {
          refreshCalls.push(url)

          return new Promise<Response>(() => {})
        }

        return json(401, {})
      })
    )

    const gateway = oauthGateway()
    let outcome: string | undefined
    void gatewayApi(gateway, { path: '/api/config', timeoutMs: 25 }, BASE).then(
      () => (outcome = 'fulfilled'),
      error => (outcome = String(error.message))
    )
    await vi.advanceTimersByTimeAsync(31_000)
    expect(outcome).toMatch(/timed out after 30s/)

    // Released: the next 401 starts a NEW refresh instead of awaiting the dead one.
    void refreshOauthTokens(gateway, BASE).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshCalls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(31_000)
  })

  it('a reply whose body stalls after the headers is bounded too', async () => {
    vi.useFakeTimers()
    const stalledBody = { status: 200, json: () => new Promise(() => {}) } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => stalledBody))

    let error: Error | undefined
    void refreshOauthTokens(oauthGateway(), BASE).catch(e => (error = e))
    await vi.advanceTimersByTimeAsync(30_500)

    expect(error?.message).toMatch(/timed out after 30s/)
  })
})
