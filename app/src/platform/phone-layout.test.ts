// Drawer dismissal on phone (phone-layout.ts), against the sidebar's real row
// structure as rendered (audited in the production build, README round 13):
//   session row: <div data-slot="context-menu-trigger" class="… shell"> → <button data-slot="row-button">
//   Show more / Back: a bare shell <div> → <button data-slot="row-button">
//   project drill-in / group label: shell → cluster <div> → <button data-slot="row-button">
//   nav item: <button data-sidebar="menu-button">
// The scenario a live smoke can't stage on a provider-less gateway: an Unread
// filter UNMOUNTS the tapped session row (openSession marks it read first),
// with focus moving to an already-open tab and no URL change.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'

import { installPhoneLayout } from './phone-layout'

let narrow = true
let closes = 0
const onReveal = (event: Event) => {
  if ((event as CustomEvent<{ mode?: string }>).detail?.mode === 'close') {
    closes++
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 400))

function press(element: Element, init: MouseEventInit = {}) {
  element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
}

function drawer(html: string) {
  document.body.innerHTML = `<div data-narrow-overlay="">${html}</div><main id="outside">chat</main>`

  return document.querySelector('[data-narrow-overlay]')!
}

const SESSION_ROW = (title: string, shellClass = '') =>
  `<div data-slot="context-menu-trigger" data-hermes-context-menu-trigger="" class="grid ${shellClass}">` +
  `<button data-slot="row-button" type="button">${title}</button>` +
  `<div data-row-actions=""><button aria-label="Session actions" type="button">⋯</button></div></div>`

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: narrow, media: query }))

  if (!window.requestAnimationFrame) {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16))
  }

  window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, onReveal)
  installPhoneLayout()
})

afterAll(() => {
  window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, onReveal)
  vi.unstubAllGlobals()
})

beforeEach(() => {
  narrow = true
  closes = 0
})

describe('phone drawer dismissal', () => {
  it('dismisses when selecting a session UNMOUNTS its row (Unread filter), focus-only, no URL change', async () => {
    const overlay = drawer(SESSION_ROW('Smoke alpha', 'bg-(--ui-row-open-background)'))
    const row = overlay.querySelector('[data-slot="row-button"]')!
    // openSession → markSessionRead clears the unread marker → the filtered
    // list drops the row before anything could observe it becoming selected.
    row.addEventListener('click', () => row.parentElement!.remove())

    press(row)
    await settle()

    expect(closes).toBeGreaterThan(0)
  })

  it('dismisses on a focus-only switch to an already-open session (row becomes selected)', async () => {
    const overlay = drawer(SESSION_ROW('Smoke alpha', 'bg-(--ui-row-open-background)'))
    const row = overlay.querySelector('[data-slot="row-button"]')!
    row.addEventListener('click', () =>
      setTimeout(() => (row.parentElement!.className = 'grid bg-(--ui-row-active-background)'), 50)
    )

    press(row)
    await settle()

    expect(closes).toBeGreaterThan(0)
  })

  it('dismisses when re-selecting the focused session and on nav items', async () => {
    let overlay = drawer(SESSION_ROW('Smoke alpha', 'bg-(--ui-row-active-background)'))
    press(overlay.querySelector('[data-slot="row-button"]')!)
    await settle()
    expect(closes).toBeGreaterThan(0)

    closes = 0
    overlay = drawer('<button data-sidebar="menu-button" type="button">Capabilities</button>')
    press(overlay.querySelector('button')!)
    await settle()
    expect(closes).toBeGreaterThan(0)
  })

  it('keeps the drawer for browsing controls, even when they replace themselves', async () => {
    const overlay = drawer(
      '<div class="grid"><button data-slot="row-button" id="more" type="button">Show more</button></div>' +
        '<div class="grid"><button data-slot="row-button" id="back" type="button">All projects</button></div>' +
        '<div data-slot="context-menu-trigger" class="grid"><div class="cluster">' +
        '<button data-slot="row-button" id="enter" type="button">Smoke project</button></div></div>'
    )

    for (const id of ['more', 'back', 'enter']) {
      const control = overlay.querySelector(`#${id}`)!
      control.addEventListener('click', () => control.parentElement!.remove())
      press(control)
    }

    await settle()

    expect(closes).toBe(0)
  })

  it('keeps the drawer for ⇧-clicks (pin/archive) and the row actions kebab', async () => {
    const overlay = drawer(SESSION_ROW('Smoke alpha'))
    press(overlay.querySelector('[data-slot="row-button"]')!, { shiftKey: true })
    press(overlay.querySelector('[aria-label="Session actions"]')!)
    await settle()

    expect(closes).toBe(0)
  })

  // session-row.tsx nests SidebarRowGrab (chrome.tsx: data-reorder-handle,
  // onClick stopPropagation) INSIDE the RowButton — directly in compact mode,
  // inside the card's header line in card mode. A sub-threshold tap on it
  // never reaches the row's resume handler, so nothing is selected.
  const GRAB = '<span data-reorder-handle="" aria-label="Reorder"><span>•</span></span>'
  const COMPACT_ROW = (shellClass = '') =>
    `<div data-slot="context-menu-trigger" class="grid ${shellClass}"><button data-slot="row-button" type="button">` +
    `${GRAB}<span data-label="">Smoke alpha</span></button><div data-row-actions=""><button aria-label="Session actions">⋯</button></div></div>`
  // Card mode nests the ⋯ <button> inside the RowButton. React builds that
  // with DOM calls; the HTML parser would split nested buttons, so build it
  // the same way here.
  const CARD_ROW = (shellClass = '') => {
    const shell = Object.assign(document.createElement('div'), { className: `grid ${shellClass}` })
    shell.dataset.slot = 'context-menu-trigger'
    const body = Object.assign(document.createElement('button'), { type: 'button' })
    body.dataset.slot = 'row-button'
    const header = document.createElement('div')
    header.innerHTML = `${GRAB}<span>ctx</span>`
    const actions = document.createElement('div')
    actions.dataset.rowActions = ''
    // session-row.tsx:233-241 (focusable <time>), the trailing PR chip
    // (pr-tag.tsx: data-pr-link, stops its click) and the ⋯ kebab — all in the
    // actions cluster, which card mode nests inside the body (:553-566).
    const time = Object.assign(document.createElement('time'), { textContent: '2h', tabIndex: 0 })
    const pr = Object.assign(document.createElement('button'), { textContent: '#12' })
    pr.dataset.prLink = ''
    const kebab = Object.assign(document.createElement('button'), { textContent: '⋯' })
    kebab.setAttribute('aria-label', 'Session actions')
    actions.append(time, pr, kebab)
    header.append(actions)
    const label = Object.assign(document.createElement('span'), { textContent: 'Smoke alpha' })
    label.dataset.label = ''
    body.append(header, label)
    shell.append(body)

    return shell
  }

  function wireRow(overlay: Element) {
    const row = overlay.querySelector('[data-slot="row-button"]')!
    const handle = overlay.querySelector('[data-reorder-handle]')!
    let resumed = 0
    handle.addEventListener('click', event => event.stopPropagation())
    overlay.querySelector('[data-pr-link]')?.addEventListener('click', event => event.stopPropagation())
    row.addEventListener('click', () => {
      resumed++
      row.parentElement!.className = 'grid bg-(--ui-row-active-background)'
    })

    return {
      handle,
      kebab: overlay.querySelector('[aria-label="Session actions"]')!,
      label: row.querySelector('[data-label]')!,
      pr: overlay.querySelector('[data-pr-link]'),
      resumed: () => resumed,
      time: overlay.querySelector('time')
    }
  }

  const rowIn = (layout: 'card' | 'compact', shellClass: string) => {
    if (layout === 'compact') {
      return drawer(COMPACT_ROW(shellClass))
    }

    const overlay = drawer('')
    overlay.append(CARD_ROW(shellClass))

    return overlay
  }

  for (const layout of ['compact', 'card'] as const) {
    it(`keeps the drawer when tapping an unfocused ${layout} row's reorder handle (no resume)`, async () => {
      const { handle, resumed } = wireRow(rowIn(layout, 'bg-(--ui-row-open-background)'))

      press(handle)
      await settle()

      expect(resumed()).toBe(0)
      expect(closes).toBe(0)
    })

    it(`keeps the drawer when tapping the FOCUSED ${layout} row's reorder handle`, async () => {
      const { handle } = wireRow(rowIn(layout, 'bg-(--ui-row-active-background)'))

      press(handle)
      await settle()

      expect(closes).toBe(0)
    })

    it(`dismisses when tapping the ${layout} row body (resume)`, async () => {
      const { label, resumed } = wireRow(rowIn(layout, 'bg-(--ui-row-open-background)'))

      press(label)
      await settle()

      expect(resumed()).toBe(1)
      expect(closes).toBeGreaterThan(0)
    })
  }

  // Round 15: the row-actions cluster is NOT excluded. In card mode it sits
  // inside the body, and its kebab and timestamp clicks bubble to onResume —
  // real selections, focus-only here (no URL change).
  for (const target of ['kebab', 'time'] as const) {
    it(`dismisses when a card row's ${target} tap resumes an unfocused session`, async () => {
      const row = wireRow(rowIn('card', 'bg-(--ui-row-open-background)'))

      press(row[target]!)
      await settle()

      expect(row.resumed()).toBe(1)
      expect(closes).toBeGreaterThan(0)
    })
  }

  it("keeps the drawer for the compact row's kebab (outside the RowButton: no resume)", async () => {
    const row = wireRow(rowIn('compact', 'bg-(--ui-row-open-background)'))

    press(row.kebab)
    await settle()

    expect(row.resumed()).toBe(0)
    expect(closes).toBe(0)
  })

  it("keeps the drawer for a card row's PR chip (stops its click: no resume)", async () => {
    const row = wireRow(rowIn('card', 'bg-(--ui-row-open-background)'))

    press(row.pr!)
    await settle()

    expect(row.resumed()).toBe(0)
    expect(closes).toBe(0)
  })

  it('closes on a tap outside, and does nothing at tablet width', async () => {
    drawer(SESSION_ROW('Smoke alpha'))
    press(document.getElementById('outside')!)
    await settle()
    expect(closes).toBeGreaterThan(0)

    closes = 0
    narrow = false
    const overlay = drawer(SESSION_ROW('Smoke alpha'))
    press(overlay.querySelector('[data-slot="row-button"]')!)
    press(document.getElementById('outside')!)
    await settle()
    expect(closes).toBe(0)
  })
})
