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
//   4. the drawer closes on a tap outside it, or when a tap inside SELECTS:
//      it navigates, it is a nav item, or the tapped session row ends up the
//      selected row — which also covers re-selecting the current session and
//      switching focus to another already-open session, neither of which
//      changes the URL. Browsing controls inside the drawer (paging, project
//      drill-in/Back, group expansion) keep it open. The hover-out dismissal
//      never fires on touch;
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

// Taps that SELECT even when the URL doesn't change:
//   - a nav item: every sidebar menu-button calls onNavigate;
//   - a session row that is the selected row once the click has settled.
//     session-row.tsx paints its SidebarRowShell — the RowButton's direct
//     parent — with the row-active background while that session is the
//     focused one (sidebar/index.tsx selection). A plain row click resumes the
//     session via openSession, which may only FOCUS an already-open tile or
//     tab (open-session.ts) — no route change, and the row was merely
//     "open" (row-open background) at press time — so the check must run
//     after the click, not at pointerdown.
// Every other RowButton (chrome.tsx), e.g. "Show more" (workspace-header.tsx),
// project drill-in/Back (overview-row.tsx) or group expansion
// (gateway-groups.tsx), never gets a selected shell: it is browsing, and only
// closes the drawer if it actually navigates.
const NAV_ITEM = '[data-sidebar="menu-button"]'
const SELECTED_ROW = '.bg-\\(--ui-row-active-background\\)'
// Focus changes commit through the session stores a few frames after the
// click; give the selection that long to land.
const SELECTION_SETTLE_MS = 300

// What a press inside the drawer began on; one delegated click handler acts
// after the click, so nothing is attached per gesture.
let press: null | { href: string; navItem: boolean; rowButton: Element | null } = null

function isSelectedRow(rowButton: Element | null): boolean {
  return Boolean(rowButton?.isConnected && rowButton.parentElement?.matches(SELECTED_ROW))
}

function onPointerDown(event: PointerEvent) {
  const overlay = document.querySelector('[data-narrow-overlay]')
  const target = event.target as Element | null
  press = null

  if (!overlay || !target || !window.matchMedia(SIDEBAR_COLLAPSE_MEDIA_QUERY).matches) {
    return
  }

  if (overlay.contains(target)) {
    // A tap that selects hands the screen back (decided after the click).
    press = {
      href: location.href,
      navItem: Boolean(target.closest(NAV_ITEM)),
      rowButton: target.closest('[data-slot="row-button"]')
    }

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
  const pressed = press
  press = null

  if (!pressed) {
    return
  }

  const started = performance.now()

  const check = () => {
    const overlay = document.querySelector('[data-narrow-overlay]')

    if (!overlay) {
      return
    }

    if (pressed.navItem || location.href !== pressed.href || isSelectedRow(pressed.rowButton)) {
      closeDrawer(overlay)

      return
    }

    // Only a row press can still turn into a selection.
    if (pressed.rowButton && performance.now() - started < SELECTION_SETTLE_MS) {
      requestAnimationFrame(check)
    }
  }

  setTimeout(check)
}

export function installPhoneLayout(): void {
  const style = document.createElement('style')
  style.dataset.androidPhoneLayout = ''
  style.textContent = PHONE_CSS
  document.head.appendChild(style)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointercancel', () => (press = null), true)
  document.addEventListener('click', onClick, true)
}
