// Android adaptation layer check: URL/scope resolution, api() error mapping,
// and the connection descriptor the renderer boots from.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isMissingRestEndpoint } from '@/lib/gateway-rpc'

import { gatewayApi } from './api-transport'
import { bridge } from './bridge'
import { buildGatewayWsUrl, normalizeRemoteBaseUrl, pathWithProfileScope, saveGateway } from './gateway-config'

const gw = { name: 'box', httpUrl: 'http://box:9119', token: 'tok en' }

function respond(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers })
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

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
