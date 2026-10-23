# Round 14 recheck — 87f702d

Read `run/reviews/round13-recheck-cxsol.md` and reviewed commit `87f702db9aa222ac284cf2b3ddd6125ed5220c0d` against Round 13. The reorder-handle regression is fixed in compact and card layouts. The Unread unmount fix, ordinary selection paths, prior browsing exclusions, and smoke URL assertion survive. However, the additional `[data-row-actions]` exclusion introduces a new selection-without-dismissal regression in card rows.

Application code was reviewed read-only. This report is the only repository file added; independent probes and their outputs are under `/tmp`.

## Finding 1 — P2: excluding the entire actions subtree hides real card-row selections

**Location:** `app/src/platform/phone-layout.ts:90`, `:115–121`.

The fix assumes that every press inside `[data-row-actions]` cannot resume a session. That assumption is false. In card mode the actions cluster is **inside** the main RowButton (`app/src/app/chat/sidebar/session-row.tsx:302–340`, `:553–566`). Its kebab has no click-propagation guard, and its timestamp is a focusable, pointer-enabled `<time>` (`:233–241`). Clicking either bubbles to the RowButton's handler and calls `onResume()` (`:438–454`). The real `SessionActionsMenu`/`ActionsMenu`/`DropdownMenuTrigger` wrappers do not stop that click.

Round 14 nevertheless saves `selects: false` and `rowButton: null` for both targets. Consequently, neither the immediate selection rule nor the selected-row fallback can dismiss. Even when React updates the row to selected, the drawer stays open if the URL is unchanged. The production resume wiring reaches `openSession` (`app/src/app/contrib/wiring.tsx:1157`), whose existing-session focus path can avoid navigation (`app/src/app/open-session.ts:195–200`).

**Reproduction:** use card rows at phone width, with A already open and B focused. Open the drawer and tap A's timestamp, or its kebab. The click resumes A; Round 14 leaves the drawer open. Round 13 dismisses. A timestamp tap provides a reproduction independent of menu-opening behavior. Reselecting an already-focused card through either target also loses dismissal.

An independent React/jsdom probe rendered the actual `SidebarSessionRow`, shared row chrome, **real `SessionActionsMenu` and `SessionContextMenu`**, and their actual menu wrappers. Its resume callback updates React selection state; surrounding stores, drag and prewarm behavior are controlled. Each revision's actual transpiled drawer handlers processed the events. These results held for both initially focused and initially unfocused rows, with unchanged URLs throughout:

| Actual rendered target | Resume calls | Round 13 close events | Round 14 close events |
| --- | ---: | ---: | ---: |
| Compact reorder handle | 0 | 2 | 0 |
| Card reorder handle | 0 | 2 | 0 |
| Compact kebab | 0 | 0 | 0 |
| Compact timestamp | 0 | 0 | 0 |
| Card kebab | 1 | 2 | 0 |
| Card timestamp | 1 | 2 | 0 |
| Compact/card title | 1 | 2 | 2 |

Two close events are the normal requests for the two candidate edge panes. Independent Chromium 155 touch fixtures also confirmed that nested action/timestamp clicks bubble to resume, with Round 13 emitting 2 close events and Round 14 emitting 0.

The Round 13 report explicitly recorded the card kebab's existing resume behavior. The new exclusion changes dismissal without changing that behavior. The new committed card fixture contains a nested kebab, but its tests only press the handle and label; they never exercise this selecting descendant.

**Required correction:** distinguish genuinely non-resuming controls from the entire actions/metadata region, or make an excluded control actually non-selecting. Preserve dismissal for card metadata that still resumes. Cover actual card actions and timestamps with assertions for both resume and drawer behavior.

## 1. Handle taps, compact and card — PASS

For both layouts and both initial selection states, the real grab handle invoked no resume callback and emitted no close events on Round 14. Its `onClick` stops propagation (`app/src/app/chat/sidebar/chrome.tsx:348–349`); clearing the saved RowButton also prevents the focused-row fallback from closing it. The same four cases emit 2 close events on Round 13, providing a negative control. Main-row title taps still invoke one resume and dismiss in both layouts.

## 2. Unread-filter unmount — PASS

Re-ran the independent React/nanostores reproduction using the exact production `markSessionRead` function body, unread-marker filtering, a fixture focus atom, and each revision's actual drawer handlers:

| Revision | Focus after tap | Runtime unread marker | Pressed row attached | URL changed | Close events |
| --- | --- | --- | --- | --- | ---: |
| Round 13 | A | cleared | no | no | 2 |
| Round 14 | A | cleared | no | no | 2 |

Ordinary main-row presses retain pointerdown classification before React removes the row. The committed Unread-unmount test also passes.

## 3. Ordinary focus-switch, reselect, routed selection and nav — PASS

The independent handler matrix and Chromium touch checks confirm dismissal for ordinary main-row focus-only switching, reselecting the current session, routed selection, and sidebar navigation. The actual-component title checks pass in both layouts. Existing `open-session` tests still verify that focusing an existing tile/main session can avoid navigation. Finding 1 concerns selecting descendants excluded by the new guard.

## 4. Prior browsing and outside-press exclusions — PASS

The 28-case handler matrix retains the prior outcomes: Show more, including self-removal during paging; project drill-in and Back, including removal during scope changes; clustered project/gateway/group labels and carets; and sibling session actions all stay open. The source structures remain unchanged: bare shells for Show more/Back, clusters for project/group links, and an ordinary button for worktree lane headers.

Titlebar toggle, portalled dialog, menu, and popper-wrapper presses retain their exclusions. Normal outside presses close; pointer cancellation clears pending selection; at 820 px this layer dismisses neither selections nor outside presses. Unfocused Shift-click pin/archive exclusions survive. The pre-existing focused-row Shift-click selected-state fallback is unchanged from Round 13, rather than newly fixed by this commit.

The real `SidebarCronJobsSection` probe also passes against both revisions: its disclosure has `data-slot="tooltip-trigger"`, expands from false to true, invokes neither open-run nor manage, leaves the URL unchanged, and emits no close events.

## 5. Smoke unchanged-URL assertion — PASS

`app/scripts/smoke.mjs:516–519` still records a problem if the focus-switch URL changes. That prevents the success log and reaches the final nonzero exit gate at `:541–543`. The two-open-session precondition, drawer-detachment assertion and selected-row assertion remain intact.

Executed the exact URL-assertion block with controlled page stubs: unchanged URL records zero problems; changed URL records one `focus-switch scenario changed the URL` failure. This remains an assertion, not merely a log message.

## 6. Excluded-subtree audit — FAIL, as detailed in Finding 1

Source-wide searches of both markers and their render sites found no selecting controls inside the grab handles: session handles contain status/archive chrome, and project/gateway handles contain icons or profile glyphs; their common wrapper stops the click.

`[data-row-actions]` has broader meaning: it excludes a region from **drag activation**, not from selection. Compact session actions are siblings of the RowButton and correctly remain open. The card version nests the same cluster in the RowButton and permits the kebab, timestamp and ordinary metadata clicks to resume through bubbling. The PR chip is a genuinely independent control: `app/src/app/chat/pr-tag.tsx:54–61` stops click/pointerdown propagation and opens externally. A blanket exclusion cannot establish the claimed behavior for its neighboring controls.

The marker is also applied by `SidebarRowShell` to arbitrary action columns (`chrome.tsx:196`), including the project's create-session button (`projects/overview-row.tsx:204–207`). That site already lacked an ancestor main RowButton, so this commit does not newly suppress its structural classification; it further demonstrates that the marker is not a universal non-selection contract. The selecting card descendants above are the newly affected paths.

## Validation and limits

- `npm run typecheck`: passed.
- Platform/open-session/session-row/row-gesture/gateway-group suites: **7 files, 74 tests passed**.
- `node --test scripts/smoke-classifier.test.mjs`: **8 passed**.
- Independent actual-component probe: **17 tests passed**, checking 32 session-control/revision combinations plus cron disclosure against both revisions. These checks assert the observed regression as well as the preserved behavior; a green probe does not mean approval.
- Independent handler matrix: **28 expected outcomes passed**; Chromium 155 touch fixtures: **17 confirmed outcomes**.
- Independent React/nanostores Unread reproduction and exact smoke URL-assertion positive/negative checks passed.

Runnable artifacts: `node /tmp/round14-cxsol-handlers.mjs`, `node /tmp/round14-cxsol-unread.mjs`, `node /tmp/round14-cxsol-browser.mjs`, and `node /tmp/round13-cxsol-smoke-assert.mjs` (reads the current smoke source). Run the actual-component probe from `app` with `npx vitest run --config /tmp/round14-cxsol-probe/vitest.config.mts`; observations are in `/tmp/round14-cxsol-probe/results.jsonl`.

No production build or live-gateway smoke was independently run. Browser checks use DOM fixtures; component probes use actual components with controlled surrounding state; the Unread probe uses production read-clearing code with fixture filtering/focus. README historical build/smoke claims were inspected, not counted as independent verification. No additional newly introduced regression was reproduced beyond Finding 1.

## Verdict: REJECTED
