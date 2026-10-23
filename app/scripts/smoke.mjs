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

// The upstream render loop can escape into the "workspace" pane's error
// boundary ("“workspace” failed to render") — reproduced in upstream Electron
// after typing into the composer (README "Deviations"). A crashed main
// surface always fails the run.
async function assertWorkspaceAlive(p, label) {
  if (await p.getByText(/failed to render/).count()) {
    problems.push(`[${label}] an error boundary is showing ("… failed to render") — the main surface crashed`)
  }
}

await assertConnected(page, 'tablet')

// First-run overlay (DesktopOnboardingOverlay). It shows "Starting Hermes…"
// until the gateway answers setup.status + setup.runtime_check over the
// WebSocket, then hides (provider configured) or shows the provider picker
// (none configured — the scratch gateway). That is upstream behavior; what
// would be a defect is never settling. Skipping the picker is a user action.
async function settleFirstRun(p, label) {
  const started = Date.now()
  const gate = p.locator('.z-\\(--z-onboarding\\)')
  const later = p.getByText(/choose a provider later/i)
  const settled = await later
    .or(p.locator('body:not(:has(.z-\\(--z-onboarding\\)))'))
    .first()
    .waitFor({ timeout: 30_000 })
    .then(() => true, () => false)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  if (!settled) {
    problems.push(`[${label}] first-run overlay still "Starting Hermes…" after 30s (setup RPCs never answered)`)

    return
  }

  if (await later.isVisible()) {
    console.log(`[${label}] first-run overlay: provider picker after ${seconds}s (gateway has no model provider) → skipped`)
    await later.click()
    await gate.waitFor({ state: 'detached', timeout: 15_000 })
  } else {
    console.log(`[${label}] first-run overlay: none (provider configured or previously skipped)`)
  }
}

await settleFirstRun(page, 'tablet')
await assertWorkspaceAlive(page, 'tablet')

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

// Tablet parity: the phone CSS (phone-layout.ts) must not apply at >= 768px —
// overlay views keep upstream's titlebar-height gutters on every side.
await page.evaluate(() => (location.hash = '#/settings'))
await page.locator('[data-overlay-surface]').waitFor({ timeout: 15_000 })
const tabletGutter = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-overlay-surface]')).paddingLeft))
if (!(tabletGutter >= 40)) {
  problems.push(`[tablet-820] overlay side gutter is ${tabletGutter}px — phone CSS leaked to tablet width`)
}
await page.evaluate(() => (location.hash = '#/'))

const storage = await context.storageState()
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: storage, hasTouch: true, isMobile: true })
const phonePage = await phone.newPage()
watch(phonePage, { label: 'phone' })
await phonePage.goto(args.app)
// Phone: the sessions sidebar is a drawer (not mounted until opened), so the
// connected surface is the composer + the titlebar's sidebar toggle.
await phonePage.locator('[contenteditable="true"], textarea').first().waitFor({ timeout: 45_000 })
await settleFirstRun(phonePage, 'phone')
await shot(phonePage, '4-connected-phone-390')

async function phoneOverflow(surface) {
  const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

  if (overflow > 0) {
    problems.push(`[phone] ${surface} overflows the viewport by ${overflow}px`)
  }
}

// Chat input usable at phone width: on screen, editable, and a tap focuses
// it. The smoke deliberately does NOT type: typing intermittently crashes the
// workspace pane through the upstream render loop — reproduced 3/4 in the
// unmodified upstream Electron app (README "Deviations") — so a typing step
// would make this gate flaky on an upstream defect, and tolerating it would
// hide a crashed main surface.
const composer = phonePage.locator('[contenteditable="true"], textarea').first()
await composer.tap()
const composerState = await composer.evaluate(element => {
  const box = element.getBoundingClientRect()

  return {
    focused: element === document.activeElement || element.contains(document.activeElement),
    editable: element.isContentEditable || (element.tagName === 'TEXTAREA' && !element.disabled && !element.readOnly),
    onScreen: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight
  }
})
if (!composerState.focused || !composerState.editable || !composerState.onScreen) {
  problems.push(`[phone] composer not usable: ${JSON.stringify(composerState)}`)
}
await phonePage.waitForTimeout(1_000)
await assertWorkspaceAlive(phonePage, 'phone')
await phoneOverflow('chat')

const toggle = phonePage.getByRole('button', { name: /show sidebar|hide sidebar/i }).first()
await toggle.tap({ timeout: 15_000 })
await phonePage.locator('[data-narrow-overlay] [data-slot="sidebar"]').waitFor({ timeout: 15_000 })
await phonePage.waitForTimeout(500)
await shot(phonePage, '5-phone-drawer-open')

await phonePage.touchscreen.tap(370, 400) // outside the drawer (max 85vw)
await phonePage.locator('[data-narrow-overlay]').waitFor({ state: 'detached', timeout: 5_000 })

await phoneOverflow('chat (drawer closed)')

// Settings from the titlebar gear: the overlay card spans (nearly) the full
// width — phone-layout drops the side gutters.
await phonePage.getByRole('button', { name: /open settings/i }).first().tap({ timeout: 15_000 })
await phonePage.locator('[data-overlay-surface]').waitFor({ timeout: 15_000 })
await phonePage.waitForTimeout(1_000)
const card = await phonePage.evaluate(() => {
  const surface = document.querySelector('[data-overlay-surface]')
  const box = surface.firstElementChild.getBoundingClientRect()

  return { width: Math.round(box.width), viewport: window.innerWidth }
})
if (card.width < card.viewport - 24) {
  problems.push(`[phone] settings card is ${card.width}px of a ${card.viewport}px viewport (side gutters not reduced)`)
}
await phoneOverflow('settings')
await shot(phonePage, '6-phone-settings')
await phonePage.evaluate(() => (location.hash = '#/'))
await phonePage.locator('[data-overlay-surface]').waitFor({ state: 'detached', timeout: 10_000 })

// Capabilities through the drawer: navigating from inside it closes it.
await toggle.tap({ timeout: 15_000 })
await phonePage.locator('[data-narrow-overlay]').getByText('Capabilities', { exact: true }).first().tap({ timeout: 15_000 })
await phonePage.locator('[data-narrow-overlay]').waitFor({ state: 'detached', timeout: 5_000 })
if (!/#\/capabilities/.test(phonePage.url())) {
  problems.push(`[phone] drawer "Capabilities" did not navigate (at ${phonePage.url()})`)
}
await phonePage.waitForTimeout(1_500)
await phoneOverflow('capabilities')
await assertWorkspaceAlive(phonePage, 'phone')
await shot(phonePage, '7-phone-capabilities')

// Onboarding at phone width: the URL field and "Save and reconnect" sit in the
// first screen (mode cards size to content) — no saved gateway in this context.
const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
const onboardingPage = await fresh.newPage()
watch(onboardingPage, { label: 'onboarding' })
await onboardingPage.goto(args.app)
await onboardingPage.getByText('Connect to a Hermes gateway').waitFor({ timeout: 30_000 })
const fold = await onboardingPage.evaluate(() => {
  const url = document.querySelector('input[placeholder="https://gateway.example.com/hermes"]')
  const save = [...document.querySelectorAll('button')].find(b => /save (and|&) reconnect/i.test(b.textContent || ''))

  return {
    url: url ? Math.round(url.getBoundingClientRect().bottom) : null,
    save: save ? Math.round(save.getBoundingClientRect().bottom) : null,
    height: window.innerHeight,
    overflow: document.documentElement.scrollWidth - window.innerWidth
  }
})
if (fold.url === null || fold.url > fold.height || fold.save === null || fold.save > fold.height) {
  problems.push(`[phone] onboarding URL field / Save not in the first screen (url ${fold.url}, save ${fold.save}, viewport ${fold.height})`)
}
if (fold.overflow > 0) {
  problems.push(`[phone] onboarding overflows the viewport by ${fold.overflow}px`)
}
await shot(onboardingPage, '8-phone-onboarding')

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
