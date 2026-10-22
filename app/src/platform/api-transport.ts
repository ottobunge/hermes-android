// Android adaptation layer — NOT part of the vendored desktop renderer.
//
// `window.hermesDesktop.api()` over fetch. Mirrors Electron main's fetchJson
// (electron/main.ts) + api-transport.ts error/retry contract so every renderer
// classifier (isMissingRestEndpoint, auth rejection, notifyError) reads the
// same messages: HTTP >= 400 → Error("<status>: <body>") with `.statusCode`.

import type { HermesApiRequest } from '@/global'

import { pathWithProfileScope, type SavedGateway } from './gateway-config'

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const MAX_RETRIES = 2

export function httpStatusError(statusCode: number, text: string): Error & { statusCode: number } {
  const status = Number.isInteger(statusCode) && statusCode > 0 ? statusCode : 500
  const error = new Error(`${status}: ${text}`) as Error & { statusCode: number }
  error.statusCode = status

  return error
}

function htmlResponseError(url: string, statusCode: number): Error {
  if (statusCode >= 300 && statusCode < 400) {
    return new Error(
      `Expected JSON from ${url} but the request was redirected (status ${statusCode}). ` +
        'This is usually an authentication proxy in front of the gateway; check the saved token and extra gateway headers.'
    )
  }

  return new Error(
    `Expected JSON from ${url} but got HTML (status ${statusCode}). The endpoint is likely missing on the Hermes backend.`
  )
}

export function resolveTimeoutMs(timeoutMs: unknown): number {
  const parsed = Number(timeoutMs)

  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : DEFAULT_FETCH_TIMEOUT_MS
}

/** Headers for an authed gateway request (token auth: X-Hermes-Session-Token). */
export function gatewayHeaders(gateway: SavedGateway): Record<string, string> {
  return gateway.token ? { 'X-Hermes-Session-Token': gateway.token } : {}
}

async function attempt(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response

  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out connecting to Hermes backend after ${timeoutMs}ms`)
    }

    // fetch() only rejects before a response exists: the transport failed.
    throw Object.assign(new Error(`Could not reach Hermes gateway at ${url}: ${(error as Error).message}`), {
      transient: true
    })
  } finally {
    clearTimeout(timer)
  }

  // redirect:'manual' surfaces a 3xx as an opaque response (status 0).
  if (res.type === 'opaqueredirect') {
    throw htmlResponseError(url, 302)
  }

  const text = await res.text()

  if (res.status >= 400) {
    throw httpStatusError(res.status, text || res.statusText)
  }

  if (res.status >= 300) {
    throw htmlResponseError(url, res.status)
  }

  if (!text) {
    return null
  }

  if (/^\s*<(?:!doctype|html)/i.test(text) || (res.headers.get('content-type') || '').includes('text/html')) {
    throw htmlResponseError(url, res.status)
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Invalid JSON from ${url} (status ${res.status}): ${text.slice(0, 200)}`)
  }
}

export async function gatewayApi<T>(
  gateway: SavedGateway,
  request: HermesApiRequest,
  baseUrl: string
): Promise<T> {
  const method = String(request.method || 'GET').toUpperCase()
  const url = `${baseUrl}${pathWithProfileScope(request.path, request.profile)}`
  const headers: Record<string, string> = gatewayHeaders(gateway)
  let body: BodyInit | undefined

  if (request.upload) {
    // Same field name/filename/content-type as main's multipartBody(); the
    // browser writes the boundary.
    const form = new FormData()
    const blob = new Blob([request.upload.bytes], { type: request.upload.contentType || 'application/octet-stream' })
    form.append('file', blob, String(request.upload.filename || 'file').replace(/["\r\n]/g, '_'))
    body = form
  } else if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(request.body)
  }

  const timeoutMs = resolveTimeoutMs(request.timeoutMs)

  // fetch() rejects only when no response arrived, so with a browser transport
  // we cannot prove a POST never left; retry idempotent verbs only (stricter
  // than main's never-sent rule — never double-submits).
  for (let tries = 0; ; tries++) {
    try {
      return (await attempt(url, { method, headers, body }, timeoutMs)) as T
    } catch (error) {
      const retryable = (error as { transient?: boolean }).transient && IDEMPOTENT_METHODS.has(method)

      if (!retryable || tries >= MAX_RETRIES) {
        throw error
      }

      await new Promise(r => setTimeout(r, Math.min(200 * 2 ** tries, 2000)))
    }
  }
}
