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

const { values: args } = parseArgs({
  options: {
    app: { type: 'string', default: 'http://127.0.0.1:4174' },
    gateway: { type: 'string' },
    token: { type: 'string' },
    chromium: { type: 'string', default: process.env.CHROMIUM_PATH },
    out: { type: 'string', default: 'smoke-out' }
  }
})

if (!args.gateway || !args.token) {
  throw new Error('--gateway and --token are required')
}

fs.mkdirSync(args.out, { recursive: true })

const problems = []
const browser = await chromium.launch({ executablePath: args.chromium, headless: true })

function watch(page, label) {
  page.on('pageerror', error => problems.push(`[${label}] pageerror: ${error.message}`))
  page.on('console', msg => {
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
watch(page, 'onboarding')
await page.goto(args.app)
await page.getByText('Connect to a Hermes gateway').waitFor({ timeout: 30_000 })
await page.getByPlaceholder('https://gateway.example.com/hermes').fill(args.gateway)
const token = page.locator('input[type=password]')
await token.waitFor({ timeout: 15_000 }) // appears once the URL probe resolves token auth
await token.fill(args.token)
await shot(page, '1-onboarding')
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

watch(page, 'tablet')
await assertConnected(page, 'tablet')
await page.waitForTimeout(2_000)
await shot(page, '2-connected-1280')

await page.setViewportSize({ width: 820, height: 1180 })
await page.waitForTimeout(1_000)
await shot(page, '3-connected-tablet-820')

const storage = await context.storageState()
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: storage, hasTouch: true, isMobile: true })
const phonePage = await phone.newPage()
watch(phonePage, 'phone')
await phonePage.goto(args.app)
await assertConnected(phonePage, 'phone')
await phonePage.waitForTimeout(2_000)
await shot(phonePage, '4-connected-phone-390')

await browser.close()

if (problems.length) {
  console.error(`SMOKE FAILED:\n${problems.join('\n')}`)
  process.exit(1)
}

console.log('SMOKE OK: onboarding → connected chat surface (tablet + phone), zero uncaught bridge errors')
