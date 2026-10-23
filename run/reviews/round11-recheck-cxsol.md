# Round 11 recheck — 3af0bf9

Scope: the two findings in `run/reviews/round9-10-cxsol.md` and regressions introduced by their fixes. HEAD is `3af0bf9`. No tracked files were modified.

## Finding 1 — CLOSED

The original over-dismissal of browsing controls is fixed. `app/src/platform/phone-layout.ts:68` now accepts a sidebar menu button or a RowButton whose **direct parent** has the selected-session background. The actual components support that distinction:

- `app/src/app/chat/sidebar/chrome.tsx:210` and `:222` both render the shared RowButton, whose attribute comes from `app/src/components/ui/row-button.tsx:10`.
- “Show more” has an unselected SidebarRowShell parent (`app/src/app/chat/sidebar/projects/workspace-header.tsx:85`). Back has the same structure (`app/src/app/chat/sidebar/projects/overview-row.tsx:66`).
- Project drill-in (`app/src/app/chat/sidebar/projects/overview-row.tsx:180`) and group expansion (`app/src/app/chat/sidebar/gateway-groups.tsx:272`) render their links inside SidebarRowCluster (`app/src/app/chat/sidebar/chrome.tsx:297`), which does not carry the selected-session background. Project entry/exit only changes scope (`app/src/store/projects.ts:101`, `:112`). These controls do not match the navigation selector or change the URL.
- A selected session's RowButton is directly under its highlighted shell (`app/src/app/chat/sidebar/session-row.tsx:355`, `:364`, `:417`). Navigation buttons carry `data-sidebar="menu-button"` (`app/src/components/ui/sidebar.tsx:484`) and call `onNavigate` (`app/src/app/chat/sidebar/index.tsx:1618`). Those selections still dismiss, as do session selections that change the URL (`app/src/platform/phone-layout.ts:120`).

The new smoke genuinely exercises browsing at 390px: it enables project grouping before loading (`app/scripts/smoke.mjs:391`), taps “Open Smoke project” (`:407`), requires the drawer and Back row to remain (`:410`, `:415`), taps Back (`:419`), and requires the drawer and overview to remain (`:422`, `:424`). Missing fixtures fail at `:404`; they do not silently skip coverage. Restoring the broad dismissal would detach the overlay and add the failure printed in `app/README.md:319`, which reaches the nonzero exit gate at `app/scripts/smoke.mjs:448`. The README's drawer negative-control claim is consistent with the implementation.

### New same-area regression — should fix: selecting an already-open, unfocused session leaves the drawer open

**Evidence:** `app/src/platform/phone-layout.ts:71`, `:93`, `:109`, `:120`.

The narrowed rule only recognizes the session that was selected **before pointerdown**. Selecting another already-open session can change focus without changing the URL, so neither dismissal condition becomes true.

The sidebar highlights the focused session (`app/src/app/chat/sidebar/index.tsx:476`); other open sessions use `bg-(--ui-row-open-background)` (`app/src/app/chat/sidebar/session-row.tsx:185`, `:368`). A plain row click resumes the session (`:451`), reaches `openSession` (`app/src/app/contrib/wiring.tsx:1157`), and focuses an existing tile or main session without routing (`app/src/app/open-session.ts:199`; `app/src/store/session-states.ts:1855`, `:1872`, `:1956`). Thus an actual session selection can fail both the pre-press selected-class test and the URL-change test.

**Reproduction:** open session A in main and session B in a session tab; focus B. At 390px, open the drawer and tap A. A becomes focused, but its route was already the main route and the drawer stays open. The same issue occurs when selecting another existing tile. Round 10's broad rule dismissed these selections.

An isolated jsdom check of the actual transpiled handlers, using the audited row structure, confirmed this: changing an open-unfocused row to selected during click, without changing the URL, emitted **0 close events** on round 11 and **2** on round 10. The existing smoke switches ordinary routed sessions and reselects the focused session (`app/scripts/smoke.mjs:171`, `:202`); it does not open another session tab, so it misses this regression. Recognize actual session selection even when it only changes focus, while preserving the browsing exclusions, and cover that case.

## Finding 2 — CLOSED

The boundary's real output is `console.error(tag, error, componentStack)` with `[error-boundary:<label>]` or `[error-boundary]` (`app/src/components/error-boundary.tsx:53`). Both forms match `app/scripts/smoke-classifier.mjs:39`; the classifier returns a problem at `:46`. Logged render-loop errors also fail independently at `:50`. The live console listener adds these problems immediately (`app/scripts/smoke.mjs:54`), and the final gate exits 1 (`:448`). HTTP resource diagnostics return null (`app/scripts/smoke-classifier.mjs:54`). Tests explicitly cover these cases (`app/scripts/smoke-classifier.test.mjs:57`, `:65`, `:72`).

DOM checks now extend beyond the tablet Settings round-trip (`app/scripts/smoke.mjs:253`) and through drawer browsing (`:434`). Fatal steps retain previously collected problems (`:437`). The transcript-success line is conditional on that phase adding no problems (`:169`, `:207`), closing the cosmetic nit.

**Independent negative control:** feeding a boundary-shaped console event, with zero page errors and no persistent fallback, through the exact extracted `watch()` and committed final smoke gate produced exit **1**. Substituting round 10's exact `watch()` produced exit **0**. HTTP 409 and connection-refused messages through the current listener produced no problems. This directly distinguishes the fixed boundary-only case. The README's unpatched-assistant-ui output (`app/README.md:341`) is consistent with the new classifier, although that broader negative control also fails on uncaught errors and transcript checks.

## Validation and limits

- `node --test scripts/smoke-classifier.test.mjs`: **8 passed**.
- `npx vitest run src/platform`: **20 passed**, 2 files.
- `npx vitest run src/app/open-session.test.ts`: **24 passed**, including existing-session focus without navigation (`app/src/app/open-session.test.ts:83`, `:91`).
- In-memory handler checks: Show more, drill-in, Back and group expansion stayed open at 390px; selected-session, routed-session and navigation selections dismissed. At 820px, no dismissal fired. The old broad rule dismissed project browsing and the unfocused-session case, confirming both the original fix and the new regression.
- No production build, live-gateway smoke, or dependency unpatching was performed. Chromium launch was attempted but failed because `libnspr4.so` was unavailable; DOM reproduction used jsdom. Historical README smoke runs were assessed against the code, not independently rerun.

## Verdict: REJECTED
