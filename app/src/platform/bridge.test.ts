// Android adaptation layer check: URL/scope resolution, api() error mapping,
// and the connection descriptor the renderer boots from.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isMissingRestEndpoint } from '@/lib/gateway-rpc'

import { gatewayApi } from './api-transport'
import { bridge, pageLifecycle, resetActiveGatewayForTests } from './bridge'
import {
  buildGatewayWsUrl,
  loadGateway,
  normalizeRemoteBaseUrl,
  pathWithProfileScope,
  saveGateway
} from './gateway-config'

const gw = { name: 'box', httpUrl: 'http://box:9119', token: 'tok en' }

function respond(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  resetActiveGatewayForTests()
})

/** WebSocket double for the /api/ws leg of a connection test: records every
 *  URL it is dialed with, then opens (or fails) on the next microtask. */
function socketDouble(outcome: 'open' | 'error') {
  const urls: string[] = []

  class Socket {
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(url: string) {
      urls.push(url)
      queueMicrotask(() => (outcome === 'open' ? this.onopen?.() : this.onerror?.()))
    }
    close() {}
  }

  vi.stubGlobal('WebSocket', Socket)

  return urls
}

describe('gateway config', () => {
  it('normalizes URLs like Electron', () => {
    expect(normalizeRemoteBaseUrl(' box:9119/hermes/?x=1#h ')).toBe('http://box:9119/hermes')
    expect(() => normalizeRemoteBaseUrl('ftp://box')).toThrow(/http/)
  })

  it('builds token ws urls preserving path prefix and scheme', () => {
    expect(buildGatewayWsUrl('https://h.example/hermes', 'a b')).toBe('wss://h.example/hermes/api/ws?token=a%20b')
  })

  it('scopes paths with ?profile= unless already scoped', () => {
    expect(pathWithProfileScope('/api/sessions?limit=1', 'work')).toBe('/api/sessions?limit=1&profile=work')
    expect(pathWithProfileScope('/api/x?profile=all', 'work')).toBe('/api/x?profile=all')
    expect(pathWithProfileScope('/api/x', null)).toBe('/api/x')
  })
})

describe('gatewayApi', () => {
  it('sends the session token + JSON body and scopes the profile', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => respond(200, '{"ok":true}'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      gatewayApi(gw, { path: '/api/x', method: 'POST', body: { a: 1 }, profile: 'p' }, 'http://box:9119')
    ).resolves.toEqual({ ok: true })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://box:9119/api/x?profile=p')
    expect(init.headers).toMatchObject({ 'X-Hermes-Session-Token': 'tok en', 'Content-Type': 'application/json' })
    expect(init.body).toBe('{"a":1}')
  })

  it('maps HTTP errors to "<status>: <body>" with statusCode', async () => {
    vi.stubGlobal('fetch', async () => respond(404, '{"detail":"No such API endpoint: /api/x"}'))
    const error = await gatewayApi<any>(gw, { path: '/api/x' }, 'http://box:9119').catch((e: any) => e)

    expect(error.message).toBe('404: {"detail":"No such API endpoint: /api/x"}')
    expect(error.statusCode).toBe(404)
    expect(isMissingRestEndpoint(error)).toBe(true)
  })

  it('flags an HTML body as a missing endpoint', async () => {
    vi.stubGlobal('fetch', async () => respond(200, '<!doctype html><html></html>'))
    const error = await gatewayApi(gw, { path: '/api/x' }, 'http://box:9119').catch(e => e)

    expect(isMissingRestEndpoint(error)).toBe(true)
  })

  it('retries GET on transport failure but never POST', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(respond(200, '1'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(gatewayApi(gw, { path: '/api/x' }, 'http://box:9119')).resolves.toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const postMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', postMock)
    await expect(gatewayApi(gw, { path: '/api/x', method: 'POST' }, 'http://box:9119')).rejects.toThrow(/reach/)
    expect(postMock).toHaveBeenCalledTimes(1)
  })

  it('honours timeoutMs', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    )
    await expect(gatewayApi(gw, { path: '/api/x', timeoutMs: 20 }, 'http://box:9119')).rejects.toThrow(/Timed out/)
  })

  it('times out a response whose headers arrived but whose body stalls', async () => {
    const stalled = { status: 200, type: 'basic', headers: new Headers(), text: () => new Promise<string>(() => {}) }
    vi.stubGlobal('fetch', async () => stalled)

    await expect(gatewayApi(gw, { path: '/api/x', timeoutMs: 20 }, 'http://box:9119')).rejects.toThrow(
      /Timed out reading/
    )
  })
})

describe('gateway edits (credential isolation + connection switch)', () => {
  const a = { name: 'A', httpUrl: 'https://a.example', token: 'A-secret' }

  it('never carries a token to a different endpoint on either save path', async () => {
    saveGateway(a)

    await expect(
      bridge.connections.save({ id: 'gateway', kind: 'remote', label: 'B', url: 'https://b.example' })
    ).rejects.toThrow(/session token for b.example/)
    await expect(
      bridge.saveConnectionConfig({ mode: 'remote', remoteAuthMode: 'token', remoteUrl: 'https://b.example' })
    ).rejects.toThrow(/session token for b.example/)
    expect(loadGateway()).toEqual(a)
  })

  it('keeps the saved token for the same endpoint and saves a label-only edit in place', async () => {
    saveGateway(a)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await bridge.connections.save({ id: 'gateway', kind: 'remote', label: 'Renamed', url: 'https://a.example/' })

    expect(loadGateway()).toEqual({ ...a, name: 'Renamed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes a material registry edit through test → save → reload, probing the NEW gateway', async () => {
    vi.useFakeTimers()
    saveGateway(a)
    const reload = vi.spyOn(pageLifecycle, 'reload').mockImplementation(() => {})
    const sockets = socketDouble('open')
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => respond(200, '{}'))
    vi.stubGlobal('fetch', fetchMock)

    await bridge.connections.save({ id: 'gateway', kind: 'remote', label: 'B', url: 'https://b.example', token: 'B' })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://b.example/api/status',
      'https://b.example/api/sessions?limit=1'
    ])
    expect(sockets).toEqual(['wss://b.example/api/ws?token=B'])
    expect(loadGateway()).toEqual({ name: 'B', httpUrl: 'https://b.example', token: 'B' })
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a failed WebSocket probe persists nothing and schedules no reload', async () => {
    vi.useFakeTimers()
    saveGateway(a)
    const reload = vi.spyOn(pageLifecycle, 'reload').mockImplementation(() => {})
    const sockets = socketDouble('error')
    vi.stubGlobal('fetch', async () => respond(200, '{}'))

    await expect(
      bridge.connections.save({ id: 'gateway', kind: 'remote', label: 'B', url: 'https://b.example', token: 'B' })
    ).rejects.toThrow(/WebSocket/)
    await expect(
      bridge.applyConnectionConfig({
        mode: 'remote',
        remoteAuthMode: 'token',
        remoteUrl: 'https://b.example',
        remoteToken: 'B'
      })
    ).rejects.toThrow(/WebSocket/)

    expect(sockets).toEqual(['wss://b.example/api/ws?token=B', 'wss://b.example/api/ws?token=B'])
    expect(loadGateway()).toEqual(a)
    vi.advanceTimersByTime(5_000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('Test on the registry row checks the SAVED gateway while REST stays on the booted one', async () => {
    saveGateway(a)
    const sockets = socketDouble('open')
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => respond(200, '{}'))
    vi.stubGlobal('fetch', fetchMock)
    await bridge.getConnection()
    await bridge.saveConnectionConfig({
      mode: 'remote',
      remoteAuthMode: 'token',
      remoteUrl: 'https://b.example',
      remoteToken: 'B'
    })
    fetchMock.mockClear()

    await expect(bridge.connections.test('gateway')).resolves.toMatchObject({ ok: true, baseUrl: 'https://b.example' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://b.example/api/status',
      'https://b.example/api/sessions?limit=1'
    ])
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ 'X-Hermes-Session-Token': 'B' })
    expect(sockets).toEqual(['wss://b.example/api/ws?token=B'])

    await bridge.api({ path: '/api/config' })
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('https://a.example/api/config')
  })

  it('refuses to apply a gateway without a token, before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      bridge.applyConnectionConfig({ mode: 'remote', remoteAuthMode: 'token', remoteUrl: 'https://b.example' })
    ).rejects.toThrow(/session token/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(loadGateway()).toBeNull()
  })

  it('keeps REST on the booted gateway after a save (no REST/WS split)', async () => {
    saveGateway(a)
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => respond(200, '{}'))
    vi.stubGlobal('fetch', fetchMock)
    await bridge.getConnection()

    await bridge.saveConnectionConfig({
      mode: 'remote',
      remoteAuthMode: 'token',
      remoteUrl: 'https://b.example',
      remoteToken: 'B'
    })
    await bridge.api({ path: '/api/config' })

    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('https://a.example/api/config')
  })
})

describe('bridge connection', () => {
  it('resolves every profile to the saved gateway as a shared-primary remote', async () => {
    saveGateway(gw)
    vi.stubGlobal('fetch', async () => respond(200, '{"version":"9.9"}'))

    const conn = await bridge.getConnection('work')

    expect(conn).toMatchObject({
      baseUrl: 'http://box:9119',
      mode: 'remote',
      authMode: 'token',
      profile: 'work',
      sharedPrimary: true,
      remoteHermesVersion: '9.9',
      wsUrl: 'ws://box:9119/api/ws?token=tok%20en'
    })
    await expect(bridge.getGatewayWsUrl('work')).resolves.toEqual({ ok: true, wsUrl: conn.wsUrl })
  })

  it('refuses to connect without a saved gateway', async () => {
    await expect(bridge.getConnection()).rejects.toThrow(/No Hermes gateway/)
  })
})
