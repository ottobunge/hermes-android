// Gated-gateway sign-in end to end (README round 16), in headless Chromium
// against a REAL basic-auth gateway:
//   onboarding → URL → probe says oauth/"Username & Password" → Sign in →
//   the gateway's own /auth/native/authorize → /login form → loopback
//   redirect → app redeems the code → boots connected (Bearer REST, ?token= WS).
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
const restAuth = new Set()
page.on('pageerror', error => errors.push(error.message))
page.on('websocket', ws => {
  const entry = { ws, received: 0, closedAt: null, opened: Date.now() }
  ws.on('framereceived', () => entry.received++)
  ws.on('close', () => (entry.closedAt = Date.now()))
  sockets.push(entry)
})
page.on('request', request => {
  // Every authed REST call; /api/status and /api/auth/providers are public.
  const path = request.url().startsWith(`${args.gateway}/api/`) ? new URL(request.url()).pathname : ''

  if (path && path !== '/api/status' && path !== '/api/auth/providers') {
    const headers = request.headers()
    const kind = headers.authorization ? 'bearer' : headers['x-hermes-session-token'] ? 'session-token' : 'none'
    restAuth.add(kind)
    if (kind !== 'bearer') console.log(`  (${kind}) ${request.method()} ${path}`)
  }
})

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
  console.log(`REST auth seen: ${[...restAuth].join(', ') || 'none'}`)
  console.log(`WebSocket: ${live ? `${live.ws.url().replace(/token=[^&]+/, 'token=<redacted>')} open, receiving` : 'none open'}`)

  if (!intercepted || !cleanUrl) problems.push('loopback callback not handled')
  if (saved?.authMode !== 'oauth' || !saved?.token || !saved?.refreshToken) problems.push('sign-in not saved as an oauth gateway')
  if (![...restAuth].every(kind => kind === 'bearer') || !restAuth.size) problems.push(`REST did not use Bearer only: ${[...restAuth]}`)
  if (!live) problems.push('no open, receiving gateway WebSocket')
  if (await page.getByText(/couldn.t start|failed to start|failed to render/i).count()) problems.push('boot failure or boundary showing')
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

console.log('GATED E2E OK: native sign-in → connected with Bearer REST and token WebSocket')
