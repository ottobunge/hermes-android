# Round 12 recheck — 349ff6f

Reviewed `run/reviews/round11-recheck-cxsol.md`, commit `349ff6fb84a146ee3d3f6b874ade58d44c4cc0cc`, and the affected sidebar/session paths. The ordinary tab focus switch is fixed and the browsing exclusions survive. One filtered-list variant of the focus-switch regression remains, so the fix is incomplete. No tracked files were modified; this report is the only repository file added.

## Finding 1 — P2: an Unread filter can remove the pressed row before dismissal recognizes the focus switch

**Location:** `app/src/platform/phone-layout.ts:84–85`, `:102`, `:134–142`.

Round 12 retains the pressed RowButton and polls whether that same, still-connected DOM node acquires a selected parent. An actual session activation can remove the row instead. Polling for 300 ms cannot recover a node that React has unmounted.

The existing Unread status filter supplies a concrete case:

1. Have session A already open in a background tab, with B focused. A finishes in the background and has a runtime unread marker; its cached `session.unread` need not yet be true. This marker path is real: `app/src/store/session-states.ts:554` calls `markSessionUnreadFinished`, which updates `$unreadFinishedSessionIds` at `app/src/store/session-unread.ts:214–218`.
2. Enable the Unread status filter and, at phone width, open the drawer and tap A.
3. `onResumeSession` reaches `openSession` (`app/src/app/contrib/wiring.tsx:1157`). Before focusing the existing tab, `openSession` calls `markSessionRead` (`app/src/app/open-session.ts:110–114`), which synchronously removes the runtime marker (`app/src/store/session.ts:1396–1412`).
4. With no remaining unread source, A stops matching the filter: the status map reads the runtime marker (`app/src/store/session-dot-state.ts:131–132`), the sidebar checks its status (`app/src/app/chat/sidebar/index.tsx:612–613`), and `visibleSessions` filters the row out (`:654–656`). React removes the RowButton.
5. The existing-tab path focuses A without navigation (`app/src/app/open-session.ts:195–200`; `app/src/store/session-states.ts:1855–1867`). Round 12 now has neither a changed URL nor a connected selected row, and leaves the drawer open despite the successful selection.

**Independent reproduction:** a React/jsdom fixture used real nanostores, the exact `markSessionRead` function body, the audited unread-only filtering/selection structure, and each revision's actual transpiled drawer handlers. Focus itself was represented by a fixture atom. After clicking A and allowing 400 ms:

| Revision | Focus | Unread marker | Original row attached | URL changed | Close events |
| --- | --- | --- | --- | --- | --- |
| Round 10, `f794485` | A | cleared | no | no | 2 |
| Round 11, `3af0bf9` | A | cleared | no | no | 0 |
| Round 12, `349ff6f` | A | cleared | no | no | 0 |

The two events are the normal close requests for the two candidate edge panes. This is a remaining variant of round 11's regression, rather than a newly introduced failure. Session activation needs to remain recognizable when its row disappears; add this filtered-row variant to coverage while preserving the browsing exclusions. The reproduction is runnable as `node /tmp/round12-cxsol-unread.mjs` in this workspace.

## Ordinary focus switch and browsing exclusions — PASS

When the clicked row survives, reading selection after the click fixes the reported case. Focused-session state drives the highlight (`app/src/app/chat/sidebar/index.tsx:476`; `session-row.tsx:364`), and the new frame polling observes that update after the focus-only action.

Independent Chromium 155 touch checks at 390 px executed the actual transpiled handlers against audited DOM fixtures. A delayed focus-only highlight change, with the URL unchanged, emitted 2 close events on round 12 and 0 on round 11. Reselecting the current session, an ordinary routed session switch, and navigation selections also dismissed.

Show more, project drill-in, Back, and group expansion emitted no close events. Their actual structures still support this distinction:

- Show more and Back have unselected direct shells (`projects/workspace-header.tsx:85`; `projects/overview-row.tsx:66`).
- Project links and gateway group labels sit inside a RowCluster, without a selected direct parent (`projects/overview-row.tsx:180`; `gateway-groups.tsx:272`; `chrome.tsx:297`).
- Their browsing actions do not navigate or acquire a selected-session shell.

A separate 17-case jsdom handler matrix also checked removed browsing controls, group carets, session-action siblings, outside dismissal, toggle/dialog exclusions, pointer cancellation, and the 820 px guard. All expected results passed. No additional newly introduced regression was reproduced in those paths.

## Smoke coverage — genuine tab setup, with a P3 assertion gap

The new scenario genuinely sets up multiple open sessions. Its Control-click (`app/scripts/smoke.mjs:491`) resolves to `newTab` (`app/src/app/chat/sidebar/session-row-gesture.ts:42–43`) and calls `openSession(..., 'tab')` (`session-row.tsx:465–466`). The precondition requires alpha to be open but unfocused and beta selected (`smoke.mjs:494–497`), so a simple focused-row reselect cannot satisfy it. It then requires drawer detachment and alpha's selected state (`:502–510`); failures enter the final nonzero gate (`:533–535`). Missing setup does not silently skip coverage. The existing project drill-in/Back assertions remain intact (`:387–434`).

**P3:** unchanged URL is only logged at `app/scripts/smoke.mjs:514–515`, not asserted. Executing the exact new assertion block with controlled page/locator stubs accepted both an unchanged URL and a changed URL, producing zero problems in either case. Add a failure when the URL changes so future routing changes cannot turn this into a passing routed-selection test. The current code path does exercise focus-only selection, but the test does not enforce that defining property. It also leaves the Unread-filter case above uncovered.

## Validation and limits

- `npm run typecheck`: passed.
- `npx vitest run src/platform src/app/open-session.test.ts`: 44 passed.
- Targeted session-row, row-gesture, and gateway-group suites: 18 passed.
- `node --test scripts/smoke-classifier.test.mjs`: 8 passed.
- Isolated Chromium touch checks: 9 expected results passed; jsdom handler matrix: 17 passed. The additional filtered-row reproduction exposed Finding 1.
- No production build or live-gateway smoke was run. Browser checks used DOM fixtures; the filtered-row check used the real handler/read-clearing code with a minimal React filter/focus fixture, rather than the complete app. The README's historical smoke/negative-control claims were inspected, not independently rerun.

## Verdict: REJECTED
