// Gated-gateway sign-in end to end (README round 16), in headless Chromium
// against a REAL basic-auth gateway:
//   onboarding → URL → probe says oauth/"Username & Password" → Sign in →
//   the gateway's own /auth/native/authorize → /login form → loopback
//   redirect → app redeems the code → boots connected (Bearer REST, ?token= WS)
//   → sign-out: page reloads, every authenticated socket is gone (round 17).
// Headless Chromium has no MainActivity: a route on http://127.0.0.1/?code=…
// stands in for its interception (redirect to {app}/?oauth-code=&oauth-state=).
//
// usage: node scripts/gated-signin-e2e.mjs --app http://127.0.0.1:4174 \
//          --gateway http://127.0.0.1:19729 --user smoke --password … --chromium /path/to/chromium
import { parseArgs } from 'node:util'

import { chromium } from 'playwright-core'

const { values: args } = parseArgs({
  options: {
    app: { type: 'string', default: 'http://127.0.0.1:4174' },
    gateway: { type: 'string' },
    user: { type: 'string' },
    password: { type: 'string' },
    chromium: { type: 'string', default: process.env.CHROMIUM_PATH }
  }
})

const problems = []
const browser = await chromium.launch({ executablePath: args.chromium, headless: true })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
const errors = []
const sockets = []
const authedRequests = []
const gatewayUrl = new URL(args.gateway)
const prefix = gatewayUrl.pathname.replace(/\/+$/, '')
// Public before login (prefix-aware for a gateway mounted under /hermes).
const PUBLIC = new Set([`${prefix}/api/status`, `${prefix}/api/auth/providers`])
page.on('pageerror', error => errors.push(error.message))
page.on('websocket', ws => {
  const entry = { ws, received: 0, closedAt: null, opened: Date.now() }
  ws.on('framereceived', () => entry.received++)
  ws.on('close', () => (entry.closedAt = Date.now()))
  sockets.push(entry)
})
page.on('request', request => {
  const url = new URL(request.url())

  if (url.origin === gatewayUrl.origin && url.pathname.startsWith(`${prefix}/api/`) && !PUBLIC.has(url.pathname)) {
    const headers = request.headers()
    authedRequests.push({
      path: url.pathname,
      authorization: headers.authorization ?? null,
      sessionToken: headers['x-hermes-session-token'] ?? null
    })
  }
})

// Authoritative socket lifecycle: route the gateway's /api/ws through
// Playwright (still connected to the real server), so a page-side close —
// including the teardown of a reloaded document — is observed directly.
const routed = []
await page.routeWebSocket(
  url => url.pathname === `${prefix}/api/ws`,
  ws => {
    const entry = { url: ws.url(), pageClosed: false, serverClosed: false }
    const server = ws.connectToServer()
    ws.onClose((code, reason) => {
      entry.pageClosed = true
      server.close({ code, reason })
    })
    server.onClose((code, reason) => {
      entry.serverClosed = true
      ws.close({ code, reason })
    })
    routed.push(entry)
  }
)

// MainActivity stand-in: the loopback callback becomes the app callback.
let intercepted = null
await page.route(/^http:\/\/127\.0\.0\.1\/\?/, route => {
  const callback = new URL(route.request().url())
  intercepted = callback.searchParams.get('state')
  const back = new URL('/', args.app)
  back.searchParams.set('oauth-code', callback.searchParams.get('code') ?? '')
  back.searchParams.set('oauth-state', callback.searchParams.get('state') ?? '')

  return route.fulfill({ status: 302, headers: { Location: back.toString() } })
})

try {
  await page.goto(args.app)
  await page.getByText('Connect to a Hermes gateway').waitFor({ timeout: 30_000 })
  await page.getByPlaceholder('https://gateway.example.com/hermes').fill(args.gateway)
  // A password provider (supports_password) gets the plain "Sign in" copy;
  // an OAuth one would read "Sign in with <provider>".
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  await signIn.waitFor({ timeout: 20_000 })
  console.log('probe → gated, password provider: "Sign in" button shown')
  await signIn.click()

  await page.waitForURL(url => url.href.startsWith(`${args.gateway}/login`), { timeout: 20_000 })
  console.log(`gateway login page: ${new URL(page.url()).pathname}`)
  await page.locator('input[name="username"]').fill(args.user)
  await page.locator('input[name="password"]').fill(args.password)
  await page.locator('button[type="submit"]').click()

  await page.waitForURL(url => url.href.startsWith(args.app), { timeout: 20_000 })
  await page.locator('[contenteditable="true"], textarea').first().waitFor({ timeout: 45_000 })
  await page.waitForTimeout(3_000)

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hermes.android.gateway') || 'null'))
  const cleanUrl = !/oauth-(code|state)/.test(page.url())
  const gatewaySockets = sockets.filter(({ ws }) => ws.url().startsWith(args.gateway.replace(/^http/, 'ws')))
  // The renderer may cycle a socket while it boots; what matters is that a
  // token-authenticated one is open and talking at the end.
  const live = gatewaySockets.find(({ ws, received }) => !ws.isClosed() && received > 0)
  for (const { ws, received, closedAt, opened } of gatewaySockets) {
    console.log(`  ws ${ws.isClosed() ? `closed after ${closedAt - opened}ms` : 'open'}, ${received} frames received`)
  }
  console.log(`loopback callback intercepted: ${intercepted ? 'yes' : 'no'}; app URL cleaned: ${cleanUrl}`)
  console.log(
    `saved gateway: authMode=${saved?.authMode} token=${saved?.token ? 'set' : 'missing'} refreshToken=${saved?.refreshToken ? 'set' : 'missing'} expiresAt=${saved?.tokenExpiresAt}`
  )
  // REST: exactly `Bearer <saved access token>`, and no session-token header.
  const wrongAuth = authedRequests.filter(
    request => request.authorization !== `Bearer ${saved?.token}` || request.sessionToken !== null
  )
  console.log(
    `REST: ${authedRequests.length} authed requests, ${authedRequests.length - wrongAuth.length} with exactly "Bearer <saved access token>" and no session-token header`
  )
  for (const request of wrongAuth.slice(0, 5)) {
    console.log(`  wrong auth on ${request.path}: authorization=${request.authorization ? 'set' : 'none'} session-token=${request.sessionToken ? 'set' : 'none'}`)
  }

  // WS: the live socket is /api/ws carrying the saved access token.
  const liveUrl = live ? new URL(live.ws.url()) : null
  const wsMatches = Boolean(liveUrl && liveUrl.pathname === `${prefix}/api/ws` && liveUrl.searchParams.get('token') === saved?.token)
  console.log(`WebSocket: ${live ? `${liveUrl.pathname} open, receiving; token = saved access token: ${wsMatches}` : 'none open'}`)

  if (!intercepted || !cleanUrl) problems.push('loopback callback not handled')
  if (saved?.authMode !== 'oauth' || !saved?.token || !saved?.refreshToken) problems.push('sign-in not saved as an oauth gateway')
  if (!authedRequests.length || wrongAuth.length) problems.push(`REST auth not exactly Bearer <access token>: ${wrongAuth.length} of ${authedRequests.length}`)
  if (!live || !wsMatches) problems.push('no open, receiving /api/ws socket carrying the saved access token')
  if (await page.getByText(/couldn.t start|failed to start|failed to render/i).count()) problems.push('boot failure or boundary showing')

  // Sign-out (round 17): credentials cleared, then a controlled reload — no
  // authenticated socket may survive it, and none may reopen with the old token.
  const before = gatewaySockets.map(entry => entry.ws)
  const routedBefore = routed.filter(entry => !entry.pageClosed)
  const errorsBeforeLogout = errors.length
  const reload = page.waitForEvent('load', { timeout: 20_000 }).then(
    () => true,
    () => false
  )
  await page.evaluate(base => window.hermesDesktop.oauthLogoutConnectionConfig(base), args.gateway)
  const reloaded = await reload
  const gatewayScreen = await page
    .getByText('Connect to a Hermes gateway')
    .waitFor({ timeout: 15_000 })
    .then(
      () => true,
      () => false
    )
  await page.waitForTimeout(2_000)

  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('hermes.android.gateway') || 'null'))
  // Playwright's WebSocket.isClosed() is not authoritative across a document
  // teardown; the routed view is (page side AND server side).
  const survivors = routedBefore.filter(entry => !entry.pageClosed || !entry.serverClosed)
  const reopened = routed
    .filter(entry => !routedBefore.includes(entry) && !entry.pageClosed)
    .filter(entry => new URL(entry.url).searchParams.get('token') === saved?.token)
  console.log(
    `sign-out: reloaded=${reloaded}, Gateway screen=${gatewayScreen}; stored token ${after?.token ? 'PRESENT' : 'cleared'}; ` +
      `${routedBefore.length - survivors.length}/${routedBefore.length} open pre-logout sockets closed (page + server side); ` +
      `${reopened.length} reopened with the old token; ${errors.length - errorsBeforeLogout} page errors across the reload` +
      ` [Playwright isClosed(): ${before.filter(ws => ws.isClosed()).length}/${before.length}]`
  )

  if (!reloaded || !gatewayScreen) problems.push(`sign-out did not reload into the Gateway screen (reload: ${reloaded}, screen: ${gatewayScreen})`)
  if (after?.token || after?.refreshToken) problems.push('sign-out left a stored token')
  if (survivors.length) problems.push(`${survivors.length} authenticated socket(s) survived sign-out`)
  if (reopened.length) problems.push('a socket reopened with the signed-out token')
} catch (error) {
  problems.push(`fatal: ${String(error?.message || error).split('\n')[0]}`)
}

await page.screenshot({ path: '/tmp/gated-e2e.png' }).catch(() => {})
await browser.close()
problems.push(...errors.map(message => `pageerror: ${message}`))

if (problems.length) {
  console.error(`GATED E2E FAILED:\n${problems.join('\n')}`)
  process.exit(1)
}

console.log(
  'GATED E2E OK: native sign-in → connected with exact Bearer REST and token WebSocket → sign-out leaves no live socket'
)
