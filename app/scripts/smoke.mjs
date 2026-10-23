// Boot smoke: serve dist/ (vite preview), then in headless Chromium:
//   1. fresh profile → onboarding (the reused Settings → Gateway panel)
//   2. fill URL + token through that UI → "Save and reconnect" → reload
//   3. connected app renders (sidebar + composer) at tablet and phone widths
// Fails on any uncaught page error, `hermesDesktop.* is not a function`, or a
// missing surface. Screenshots land in --out.
//
// usage: node scripts/smoke.mjs --app http://127.0.0.1:4174 --gateway http://127.0.0.1:19719 \
//          --token <token> --chromium /path/to/chromium --out smoke-out
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { chromium } from 'playwright-core'

import { classifyPageErrors, findGuardSite, KNOWN_LOOP_LIMIT_PER_PHASE } from './smoke-classifier.mjs'

const { values: args } = parseArgs({
  options: {
    app: { type: 'string', default: 'http://127.0.0.1:4174' },
    gateway: { type: 'string' },
    token: { type: 'string' },
    chromium: { type: 'string', default: process.env.CHROMIUM_PATH },
    out: { type: 'string', default: 'smoke-out' },
    // The build being served (for locating the render-loop guard site).
    dist: { type: 'string', default: 'dist' }
  }
})

if (!args.gateway || !args.token) {
  throw new Error('--gateway and --token are required')
}

fs.mkdirSync(args.out, { recursive: true })

// Where THIS build's tap render-loop guard throws (fail closed: null → no
// allowance). A served guard frame whose filename or coordinates differ from
// the scanned site is rejected.
const assetsDir = path.join(args.dist, 'assets')
const guardSite = findGuardSite(
  (fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [])
    .filter(name => name.endsWith('.js'))
    .map(name => ({ name, source: fs.readFileSync(path.join(assetsDir, name), 'utf8') }))
)
console.log(
  guardSite
    ? `render-loop guard site: ${guardSite.file}:${guardSite.line}:${guardSite.column}`
    : 'render-loop guard site: NOT identified in this build — no page error will be tolerated'
)

const problems = []
const pageErrors = []
const browser = await chromium.launch({ executablePath: args.chromium, headless: true })

// One listener set per page; `phase.label` moves with the run so a page's
// errors are attributed (and counted) once. Page errors are judged at the end
// by smoke-classifier.mjs.
function watch(page, phase) {
  page.on('pageerror', error => pageErrors.push({ phase: phase.label, message: error.message, stack: error.stack }))
  page.on('console', msg => {
    const label = phase.label
    const text = msg.text()

    if (msg.type() === 'error') {
      console.log(`[${label}] console.error: ${text.slice(0, 300)}`)
    }

    if (/hermesDesktop[^\n]* is not a function|is not a function[^\n]*hermesDesktop/i.test(text)) {
      problems.push(`[${label}] ${text}`)
    }
  })
}

async function shot(page, name) {
  const file = path.join(args.out, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(`screenshot: ${file}`)
}

// 1–2. Onboarding through the real Gateway settings form.
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
const desktop = { label: 'onboarding' }
watch(page, desktop)
await page.goto(args.app)
await page.getByText('Connect to a Hermes gateway').waitFor({ timeout: 30_000 })
await page.getByPlaceholder('https://gateway.example.com/hermes').fill(args.gateway)
const token = page.locator('input[type=password]')
await token.waitFor({ timeout: 15_000 }) // appears once the URL probe resolves token auth
await token.fill(args.token)
await shot(page, '1-onboarding')
// "Save and reconnect" reloads into the app: from that navigation on, the page
// is the connected surface, not onboarding.
page.on('framenavigated', frame => {
  if (frame === page.mainFrame() && desktop.saved) {
    desktop.label = 'tablet'
  }
})
desktop.saved = true
await Promise.all([
  page.waitForEvent('load', { timeout: 30_000 }),
  page.getByRole('button', { name: /save (and|&) reconnect/i }).click()
])

// 3. Connected app.
async function assertConnected(p, label) {
  await p.locator('[data-slot="sidebar"], [data-sidebar="sidebar"]').first().waitFor({ state: 'attached', timeout: 45_000 })
  await p.locator('[contenteditable="true"], textarea').first().waitFor({ timeout: 45_000 })
  const failure = await p.getByText(/couldn.t start|failed to start/i).count()

  if (failure) {
    problems.push(`[${label}] boot failure overlay is showing`)
  }
}

await assertConnected(page, 'tablet')

// Production build ships the wordmark face (resolved from app/node_modules).
const fontFaces = await page.evaluate(async () => (await document.fonts.load('700 32px Collapse')).length)
if (!fontFaces) {
  problems.push('[tablet] Collapse wordmark font did not load')
}

// Electron <webview> previews fail explicitly on Android (webview-unavailable.ts).
const webviewFailure = await page.evaluate(
  () =>
    new Promise(resolve => {
      const webview = document.createElement('webview')
      webview.setAttribute('src', 'https://example.com/')
      webview.addEventListener('did-fail-load', event => resolve(event.errorDescription || ''))
      setTimeout(() => resolve(''), 2_000)
    })
)
if (!/not available on Android/.test(String(webviewFailure))) {
  problems.push('[tablet] <webview> preview did not report unavailable')
}
await page.waitForTimeout(2_000)
await shot(page, '2-connected-1280')

await page.setViewportSize({ width: 820, height: 1180 })
await assertConnected(page, 'tablet-820')
await page.waitForTimeout(1_000)
await shot(page, '3-connected-tablet-820')

const storage = await context.storageState()
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: storage, hasTouch: true, isMobile: true })
const phonePage = await phone.newPage()
watch(phonePage, { label: 'phone' })
await phonePage.goto(args.app)
// Phone: the sessions sidebar is a drawer (not mounted until opened), so the
// connected surface is the composer + the titlebar's sidebar toggle.
await phonePage.locator('[contenteditable="true"], textarea').first().waitFor({ timeout: 45_000 })
// A gateway with no model provider puts the first-run provider picker over
// the app; skipping it is a user action, not a boot failure.
const later = phonePage.getByText(/choose a provider later/i)
const gate = phonePage.locator('.z-\\(--z-onboarding\\)')
await later.or(phonePage.locator('body:not(:has(.z-\\(--z-onboarding\\)))')).first().waitFor({ timeout: 45_000 })
if (await later.isVisible()) {
  await later.tap()
  await gate.waitFor({ state: 'detached', timeout: 15_000 })
}
await shot(phonePage, '4-connected-phone-390')

const toggle = phonePage.getByRole('button', { name: /show sidebar|hide sidebar/i }).first()
await toggle.tap({ timeout: 15_000 })
await phonePage.locator('[data-narrow-overlay] [data-slot="sidebar"]').waitFor({ timeout: 15_000 })
await phonePage.waitForTimeout(500)
await shot(phonePage, '5-phone-drawer-open')

await phonePage.touchscreen.tap(370, 400) // outside the drawer (max 85vw)
await phonePage.locator('[data-narrow-overlay]').waitFor({ state: 'detached', timeout: 5_000 })

const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
if (overflow > 0) {
  problems.push(`[phone] page overflows the viewport by ${overflow}px`)
}

await browser.close()

const verdict = classifyPageErrors(pageErrors, guardSite)
problems.push(...verdict.problems)

for (const [label, count] of Object.entries(verdict.tolerated)) {
  console.log(
    `[${label}] baseline-shaped render-loop pageerror ×${count} (tolerated, bound ${KNOWN_LOOP_LIMIT_PER_PHASE}): ` +
      'guard message, top frame exactly at the guard site'
  )
}

if (problems.length) {
  console.error(`SMOKE FAILED:\n${problems.join('\n')}`)
  process.exit(1)
}

console.log(
  'SMOKE OK: onboarding → connected chat surface (tablet + phone), page errors limited to the bounded ' +
    'baseline render-loop shape, zero bridge errors'
)
