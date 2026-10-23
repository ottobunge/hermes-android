# Round 15 recheck — 01b2750

Read `run/reviews/round14-recheck-cxsol.md` and the preceding rechecks, then reviewed commit `01b2750101cefb296407ce999b9cf1e0d9c4a8ba` against Round 14 (`87f702d`). **The card kebab/timestamp regression is closed. No new regression was reproduced across the full previously audited control matrix or the additional nested-control checks below.**

Application code was reviewed read-only. This report is the only repository file added by this review; independent probes and their results are under `/tmp`.

## 1. Card kebab and timestamp — PASS

The actual exclusion at `app/src/platform/phone-layout.ts:95` is `[data-reorder-handle], [data-pr-link]`, rather than literally only the handle. Removing the broad `[data-row-actions]` exclusion restores selection classification for the card's kebab and timestamp. Keeping the specific PR-link exclusion is correct: that control stops propagation and opens externally without resuming a session.

Re-ran the independent React/jsdom probe with the actual `SidebarSessionRow`, shared row chrome, **real `SessionActionsMenu` and `SessionContextMenu`**, their menu wrappers, and each revision's actual transpiled drawer handlers. The resume callback updates React selection state. Both focused and unfocused initial states were checked, with unchanged URLs:

| Rendered target | Resume calls | Round 14 close events | Round 15 close events |
| --- | ---: | ---: | ---: |
| Card kebab | 1 | 0 | 2 |
| Card timestamp | 1 | 0 | 2 |
| Compact kebab | 0 | 0 | 0 |
| Compact timestamp | 0 | 0 | 0 |
| Compact/card reorder handle | 0 | 0 | 0 |
| Compact/card main title | 1 | 2 | 2 |

Two close events are the normal close requests for the two candidate edge panes. Card actions still sit inside the main RowButton (`session-row.tsx:553–566`) and bubble to its resume handler (`:438–454`); compact actions remain siblings. Chromium 155 touch fixtures independently confirm card action/timestamp dismissal and compact-kebab preservation.

## 2. Nested controls, both layouts and selection states — PASS

Extended the real-component probe beyond the original four targets. Every applicable compact/card case below was checked with the row initially focused and initially unfocused. Assertions cover resume calls, close events, unchanged URL, and external-opening calls where relevant.

| Control/region | Compact | Card |
| --- | --- | --- |
| Reorder handle, inner status dot, archived glyph, branch stem inside handle | No resume; stays open | No resume; stays open |
| Status dot/archive glyph without a reorder handle | Resumes; dismisses | Resumes; dismisses |
| Kebab icon descendant | No resume; stays open | Resumes; dismisses |
| Actions-container region | No resume; stays open | Resumes; dismisses |
| Timestamp, profile chip, token/cost figures in actions region | No resume; stays open | Resumes; dismisses |
| PR button, number descendant, icon descendant | One external-open call; no resume; stays open | One external-open call; no resume; stays open |
| Main title, preview, leading/trailing decoration spans, handoff badge | Resumes; dismisses | Resumes; dismisses |
| Detailed inline metadata | Resumes; dismisses | Rendered as card content below |
| Card context, model, message count, task-progress footer | Not applicable | Resumes; dismisses |

The specific exclusions clear both the structural selection flag and the saved RowButton (`phone-layout.ts:120–126`). That prevents the selected-row fallback from dismissing a focused handle or PR-link press. Testing the PR chip's number/icon descendants also verifies that `closest()` protects the whole control, rather than only its root.

Repeated source-wide searches of `SidebarRowBody`, `SidebarRowLink`, `RowButton`, `data-row-actions`, `data-reorder-handle`, and propagation guards agree with the observed matrix. The handle and PR chip are the shipped nested controls that suppress resume; card metadata and actions are selecting descendants. Other propagation guards belong to section headers, project/worktree menus, connection controls, or the row's modifier-click branch. No additional built-in nested control requiring an exclusion was found. Decoration checks use controlled span contributions; arbitrary third-party plugin implementations are outside this review.

## 3. Unread unmount, focus switch, reselect, routed and nav — PASS

Re-ran the React/nanostores Unread reproduction using the exact production `markSessionRead` function body, runtime unread-marker filtering, a fixture focus atom, and the actual drawer handlers:

| Revision | Focus after tap | Runtime unread marker | Pressed row attached | URL changed | Close events |
| --- | --- | --- | --- | --- | ---: |
| Round 14 | A | Cleared | No | No | 2 |
| Round 15 | A | Cleared | No | No | 2 |

Pointerdown classification still survives React removing the row. Ordinary main/tile focus-only switches, reselecting the focused session, routed selection, and sidebar navigation all dismiss in the handler matrix and Chromium touch fixtures. The real title checks pass in both layouts. Existing `open-session` tests continue to cover focusing an already-open session without navigation.

## 4. All prior browsing and outside-press exclusions — PASS

Re-ran the complete prior handler matrix and extended it to 35 cases. Audited every production sidebar RowButton/RowLink render site and exercised the shared/leaf browsing components with the current handlers:

| Browsing/control family | Result |
| --- | --- |
| Show more rows, icon pagination, recents/messaging/cron load-more controls | Stay open |
| Paging that removes its own control | Stays open |
| Project drill-in, Back/All projects, including scope changes removing the pressed control | Stay open |
| Project, gateway and profile labels; their separate carets | Stay open |
| Project/gateway grab handles and their inner icons | Stay open; no browsing action invoked |
| Worktree/repository lane label and caret | Stay open |
| Date/status grouping disclosure chrome | Stays open |
| Cron job disclosure | Expands; no open-run/manage callback; stays open |
| Search input, filter trigger, section disclosure, header scope-back button | Stay open |
| Session actions/metadata beside the compact RowButton; selected shell background | Stay open |
| Titlebar toggle, portalled dialog, menu and popper wrapper | Do not trigger outside dismissal |
| Ordinary outside press | Dismisses |
| Pointer cancellation | Clears the pending selection |
| Selection or outside press at 820 px | Neither triggers dismissal from this layer |

The real cron component still renders its disclosure with `data-slot="tooltip-trigger"`, so it does not become a session-row selection. The project/profile/gateway links remain clustered, Show more/Back retain bare shells, and lane headers remain ordinary buttons. Removing the broad actions exclusion does not change those distinctions.

Unfocused Shift-click pin/archive exclusions also survive. As already documented in Rounds 13/14, the focused-row Shift-click selected-state fallback closes in both the baseline and current handlers. That inherited behavior is unchanged, not a new Round 15 regression or a newly claimed fix.

## 5. Smoke checks and same-area regression audit — PASS

The focus-only smoke scenario still requires two genuinely open sessions, drawer detachment, the selected target row, and an unchanged URL (`app/scripts/smoke.mjs:516–550`). Executed the exact URL-assertion block: unchanged URL records no problem; changed URL records a failure that reaches the final nonzero gate. Error-boundary/render-loop classifier tests still pass.

Also inspected the additional composer-stability change in this commit. The exact extracted predicate waits for 1,500 ms on the same editor and resets on replacement; an absent editor does not pass. Its timeout records a problem. The subsequent focus/text checks and accumulated-error failure gate remain intact. This change does not weaken the drawer assertions.

No new same-area regression was reproduced. The existing selecting card descendants dismiss again, the specific non-selecting descendants stay open, and all previously audited browsing paths retain their outcomes. There are no new findings or nits.

## Validation and limits

- `npm run typecheck`: **passed**.
- `npx vitest run --maxWorkers 1 --reporter verbose src/platform src/app/open-session.test.ts src/app/chat/sidebar/session-row.test.tsx src/app/chat/sidebar/session-row-gesture.test.ts src/app/chat/sidebar/gateway-groups.test.tsx`: **7 files, 78 tests passed**.
- `node --test scripts/smoke-classifier.test.mjs`: **8 passed**.
- Independent actual-component probes: **106 tests passed** (94 main checks plus 12 supplemental checks), recording **123 control/revision observations**, including baseline negative controls for the card regression.
- Independent handler matrix: **35 expected outcomes passed**; Chromium 155 touch fixtures: **23 confirmed outcomes**, including historical controls.
- Independent React/nanostores Unread reproduction, exact smoke URL assertion positive/negative checks, exact composer-stability predicate checks, and smoke-script syntax check: **passed**.

An initial expanded Vitest invocation encountered transport stack overflows and a V8 RegExpCompiler allocation failure; expanded attempts were stopped. The seven-file validation scope above subsequently completed successfully with one worker. No passing result is claimed for the interrupted expanded runs.

Runnable artifacts:

```sh
# From app:
npx vitest run --config /tmp/round15-cxsol-probe/vitest.config.mts --maxWorkers 1
npx vitest run --config /tmp/round15-cxsol-probe/addon.config.mts --maxWorkers 1 -t '^matrix'
node /tmp/round15-cxsol-handlers.mjs
node /tmp/round15-cxsol-unread.mjs
node /tmp/round15-cxsol-browser.mjs
node /tmp/round13-cxsol-smoke-assert.mjs
node /tmp/round15-cxsol-smoke-stability.mjs
```

Component observations and logs are in `/tmp/round15-cxsol-probe/{results.jsonl,addon-results.jsonl,test.log,addon.log}`; handler/browser outputs and the seven-file test log are `/tmp/round15-cxsol-{handlers,browser,unit-core}.log`.

No production build or live-gateway smoke was independently run. Browser checks use audited DOM fixtures; component checks use actual controls with controlled surrounding state; the Unread reproduction uses production read-clearing code with fixture focus/filtering. Historical README build/smoke claims were inspected, not counted as independent verification.

## Verdict: APPROVED
