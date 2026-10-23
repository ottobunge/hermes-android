// Android adaptation layer — phone (<768px) presentation.
//
// Upstream already does the structural work below 640px
// (SIDEBAR_COLLAPSE_MEDIA_QUERY): rails leave the grid and the titlebar
// toggle slides them in as an overlay drawer (NarrowOverlays), the transcript
// takes the full width and the composer stays docked. This layer only fixes
// what breaks on a touch phone:
//
//   1. the drawer starts under the titlebar band instead of under its toggle;
//   2. the "HERMES AGENT" wordmark may shrink below its 2.75rem floor rather
//      than clip;
//   3. the statusbar scrolls sideways instead of clipping;
//   4. the drawer closes on a tap outside it, when a tap inside navigates, or
//      when a tap re-selects what is already showing (a nav item, or the
//      selected session row — no URL change). Browsing controls inside the
//      drawer (paging, project drill-in/Back, group expansion) keep it open.
//      The hover-out dismissal never fires on touch;
//   5. overlay views (Settings, Scheduled jobs, …) keep their titlebar-height
//      top inset but drop the ~44px side/bottom gutters, which left a 300px
//      card on a 390px screen;
//   6. the connection-mode cards (Settings → Gateway, onboarding) size to
//      their own content instead of all matching the tallest one, so the
//      URL/token fields aren't pushed below the fold on a one-column screen.
//
// Everything is gated on max-width 767.98px, so tablet (>=768px) is untouched.
// Only leaf modules are imported: this runs before the renderer evaluates.

import { SIDEBAR_COLLAPSE_MEDIA_QUERY } from '@/app/layout-constants'
import { TITLEBAR_HEIGHT } from '@/app/shell/titlebar'
import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'

// store/layout.ts CHAT_SIDEBAR_PANE_ID / FILE_BROWSER_PANE_ID — not imported
// so the layout stores don't evaluate before the bridge is installed.
const EDGE_PANE_IDS = ['chat-sidebar', 'file-browser']

const PHONE_CSS = `
@media (max-width: 767.98px) {
  [data-narrow-overlay] { top: ${TITLEBAR_HEIGHT / 16}rem; }
  .wordmark { --fit-min: 1.5rem !important; }
  [data-slot='statusbar'] > div { overflow-x: auto; scrollbar-width: none; }
  [data-overlay-surface] { padding-inline: 0.5rem; padding-bottom: 0.5rem; }
  .auto-rows-fr { grid-auto-rows: auto; }
}
`

function closeDrawer(overlay: Element) {
  const tabs = [...overlay.querySelectorAll('[data-narrow-overlay-tab]')].map(tab =>
    tab.getAttribute('data-narrow-overlay-tab')
  )

  // `close` only closes the pane that is actually revealed, so naming every
  // candidate is safe.
  for (const id of new Set([...tabs, ...EDGE_PANE_IDS])) {
    window.dispatchEvent(new CustomEvent(PANE_TOGGLE_REVEAL_EVENT, { detail: { id, mode: 'close' } }))
  }
}

// Taps that SELECT even when the URL doesn't change: a nav item (every
// sidebar menu-button calls onNavigate), or the tap target of the row that is
// already the selected one (session-row.tsx paints its SidebarRowShell — the
// RowButton's direct parent — with the row-active background). Every other
// RowButton (chrome.tsx), e.g. "Show more" (workspace-header.tsx), project
// drill-in/Back (overview-row.tsx) or group expansion (gateway-groups.tsx),
// is browsing: it only closes the drawer if it actually navigates.
const NAV_ITEM = '[data-sidebar="menu-button"]'
const SELECTED_ROW = '.bg-\\(--ui-row-active-background\\)'

function selectsInPlace(target: Element): boolean {
  const rowButton = target.closest('[data-slot="row-button"]')

  return Boolean(target.closest(NAV_ITEM) || rowButton?.parentElement?.matches(SELECTED_ROW))
}

// URL when a press inside the drawer began (and whether it pressed a
// selectable row); one delegated click handler acts after the click, so
// nothing is attached per gesture.
let hrefAtPress: null | string = null
let pressedRow = false

function onPointerDown(event: PointerEvent) {
  const overlay = document.querySelector('[data-narrow-overlay]')
  const target = event.target as Element | null
  hrefAtPress = null
  pressedRow = false

  if (!overlay || !target || !window.matchMedia(SIDEBAR_COLLAPSE_MEDIA_QUERY).matches) {
    return
  }

  if (overlay.contains(target)) {
    // A tap that navigates or selects a row hands the screen back.
    hrefAtPress = location.href
    pressedRow = selectsInPlace(target)

    return
  }

  // Outside the drawer — but not its own toggle, which already toggles, nor
  // anything layered above it (menus, dialogs portalled to <body>).
  if (target.closest('[data-titlebar-cluster], [role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) {
    return
  }

  closeDrawer(overlay)
}

function onClick() {
  const before = hrefAtPress
  const row = pressedRow
  hrefAtPress = null
  pressedRow = false

  if (before === null) {
    return
  }

  setTimeout(() => {
    const overlay = document.querySelector('[data-narrow-overlay]')

    if (overlay && (row || location.href !== before)) {
      closeDrawer(overlay)
    }
  })
}

export function installPhoneLayout(): void {
  const style = document.createElement('style')
  style.dataset.androidPhoneLayout = ''
  style.textContent = PHONE_CSS
  document.head.appendChild(style)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener(
    'pointercancel',
    () => {
      hrefAtPress = null
      pressedRow = false
    },
    true
  )
  document.addEventListener('click', onClick, true)
}
