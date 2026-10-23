# Round 13 recheck — b19d919

Reviewed `run/reviews/round12-recheck-cxsol.md`, commit `b19d919a7f91076a1192a4ae590bdf7bafd08ece`, the drawer handlers, smoke assertions, and sidebar row/control structures. The Unread-filter unmount case and P3 URL assertion are fixed. The named prior exclusions survive, but the new discriminator introduces a dismissal regression on session reorder handles.

Application code was reviewed read-only. This report is the only repository file added; temporary probes live under `/tmp`.

## Finding 1 — P2: tapping an unfocused session's reorder handle now dismisses without selecting

**Location:** `app/src/platform/phone-layout.ts:106–110`, `:135–146`.

The new pointerdown discriminator treats every descendant of a session RowButton as a selection. A reorder handle is such a descendant, but its ordinary click deliberately stops propagation instead of resuming the session:

- `session-row.tsx:473–483` places `SidebarRowGrab` inside the main `SidebarRowBody`; card mode places the same lead inside that body at `:553–554`.
- `chrome.tsx:348–349` marks the handle with `data-reorder-handle` and stops its click from reaching the row's resume handler.
- The document's capture listener nevertheless finds the ancestor RowButton, sees its direct context-menu-trigger parent, and records `selects: true`. The captured click schedules dismissal before the handle's bubble-phase handler can stop propagation. No URL or selected-state change is required anymore.

**Reproduction:** at phone width, open the drawer with session B focused and another reorderable session A visible. Tap A's status-dot/grabber area without dragging. A is not resumed, but the drawer closes. Round 12 leaves it open.

An independent React/jsdom probe rendered the actual `SidebarSessionRow`, shared row chrome, and real `ActionsContextMenu`/`ActionsMenu` wrappers, with unrelated stores/actions controlled. It executed each revision's actual transpiled drawer handlers:

| Target on an unfocused session | Revision | Resume calls | Close events |
| --- | --- | --- | --- |
| Compact-row reorder handle | Round 12 | 0 | 0 |
| Compact-row reorder handle | Round 13 | 0 | 2 |
| Card-row reorder handle | Round 12 | 0 | 0 |
| Card-row reorder handle | Round 13 | 0 | 2 |

The two close events name the two candidate edge panes. Independent Chromium 155 touch checks at 390 px reproduced the same 0 → 2 change against the audited nested-handle structure, with no resume or URL change. These are sub-threshold taps, not completed drags.

The structural test must exclude non-selecting nested controls, including the reorder handle, while retaining recognition of a main-row selection before an Unread filter removes it. Add coverage for an unfocused row's handle in both layouts. The committed test only checks a sibling kebab; that does not exercise a control nested inside the RowButton.

## Unread-filter unmount — PASS

Re-ran the Round 12 React/nanostores reproduction with the real session-row context-menu marker added to its shell. It uses the actual `markSessionRead` function body, runtime unread-marker filtering, and each revision's actual drawer handlers; focus is represented by a fixture atom.

| Revision | Focus after tap | Runtime unread marker | Pressed row attached | URL changed | Close events |
| --- | --- | --- | --- | --- | --- |
| Round 12 | A | cleared | no | no | 0 |
| Round 13 | A | cleared | no | no | 2 |

Recording the selection classification at pointerdown survives the row's React unmount. The new committed unmount test also passes. Ordinary focus-only switching, reselecting the current session, routed selection, and navigation-item selection continue to dismiss.

## Prior exclusions and neighboring controls — PASS, except Finding 1

The independent 28-case handler matrix passed its expected outcomes, including:

- Show more, including removal of its own control during paging: stays open.
- Project drill-in and Back, including controls removed by the transition: stay open.
- Gateway/group labels and carets, including context-menu shells around clustered labels: stay open.
- Sibling session-action controls: stay open.
- Titlebar toggle, portalled dialog, menu, and popper-wrapper presses: do not trigger outside dismissal.
- A normal outside press: closes.
- At 820 px, session selection and outside presses: neither triggers this layer's dismissal.
- Pointer cancellation clears the pending selection.

The production structures still explain the browsing exclusions: Show more and Back have bare direct shells; project/profile/gateway labels sit inside `SidebarRowCluster`; worktree lane headers use an ordinary button without the RowButton marker.

**Cron disclosure checked against the actual rendered component:** its source initially looks like another match (`ActionsContextMenu → SidebarRowShell → SidebarRowBody`), and Round 13's comment describes cron rows as selections. However, its enclosing `Tip` overrides the main button's `data-slot` to `tooltip-trigger`, because RowButton spreads incoming props after its own marker. It therefore does **not** match `[data-slot="row-button"]`. Rendering the real `SidebarCronJobsSection` and exercising both revisions confirmed `aria-expanded: false → true`, zero open-run/manage calls, unchanged URL, and zero close events in both versions. A simplified fixture retaining `row-button` would incorrectly report a cron regression.

The real-row probe also checked compact and card kebabs. The compact kebab remains outside the RowButton and does not dismiss. The card kebab is nested, but its click already invokes the row's resume callback in both revisions; that pre-existing behavior is not evidence of a newly non-selecting control regression. The reorder handle above, by contrast, demonstrably invokes no resume callback.

## Smoke unchanged-URL assertion (P3) — PASS

`app/scripts/smoke.mjs:516–519` now pushes a problem when `focusPage.url() !== before.url`. That problem reaches the nonzero exit gate at `:541–543`, and prevents the success log. The two-open-session precondition and drawer-detachment/selected-row checks remain intact.

Executed the exact new assertion block with controlled page stubs: unchanged URL produced zero problems; changed URL produced one `focus-switch scenario changed the URL` failure. This closes the previously reported logging-only gap.

## Validation and limits

- `npm run typecheck`: passed.
- Platform/open-session/session-row/row-gesture/gateway-group suites: 7 files, 68 tests passed, including the six new drawer tests.
- `node --test scripts/smoke-classifier.test.mjs`: 8 passed.
- Independent actual-component probes: 2 passed, checking both revisions and confirming the handle regression and cron exclusion.
- Independent handler matrix: 28 expected results passed; Chromium 155 touch fixture checks: 9 confirmed outcomes, including the handle negative control.
- Independent React/nanostores Unread reproduction and exact smoke-assertion positive/negative checks passed.

Runnable probes: `node /tmp/round13-cxsol-unread.mjs`, `node /tmp/round13-cxsol-handlers.mjs`, `node /tmp/round13-cxsol-browser.mjs`, and `node /tmp/round13-cxsol-smoke-assert.mjs`. The actual-component probes run from `app` with `npx vitest run --config /tmp/round13-cxsol-probe/vitest.config.mts`; their observations are saved in `/tmp/round13-cxsol-probe/results.jsonl`.

No production build or live-gateway smoke was independently run. Browser checks used DOM fixtures; the component and Unread probes use real components/handlers or read-clearing code with controlled surrounding state, not a full app/backend. README historical build/smoke claims were inspected, not treated as independently verified results.

## Verdict: REJECTED
