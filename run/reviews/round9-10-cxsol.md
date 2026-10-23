# Review: rounds 9–10

Reviewed `a78fc2a` and `f794485`, including the installed `@assistant-ui/core@0.2.23` implementation. No tracked source files were modified.

## Findings

### Should-fix — drawer dismissal also catches sidebar browsing controls

**Evidence:** `app/src/platform/phone-layout.ts:58`, `:79`, `:106`.

The new same-session dismissal matches every `[data-slot="row-button"]` and closes the drawer after its click, regardless of whether that click selected a session. That attribute identifies a shared button component, not a session-selection action. `SidebarRowBody` and `SidebarRowLink` both render it (`app/src/app/chat/sidebar/chrome.tsx:211`, `:222`). Existing non-selection callers include:

- “Show more” paging controls (`app/src/app/chat/sidebar/projects/workspace-header.tsx:86`).
- Project drill-in and Back controls (`app/src/app/chat/sidebar/projects/overview-row.tsx:180`, `:67`). Entering a project only changes sidebar scope and explicitly never opens a session (`app/src/store/projects.ts:98`).
- Gateway/profile group expansion labels (`app/src/app/chat/sidebar/gateway-groups.tsx:272`).

On a phone, these actions now dismiss the drawer before the user can browse the rows they revealed, requiring another drawer-open action. This is a round-10 regression from the previous URL-change condition.

**Reproduction:** evaluated the actual `phone-layout.ts` handlers in an isolated jsdom document with the existing paging-control markup. A pointerdown/click at 390px, with no URL change, emitted both edge-pane close events. At 820px it emitted none. No repository source was changed for this check.

Restrict the same-selection exception to actual session/navigation actions; keep paging, grouping, and project browsing inside the drawer. The current smoke only exercises session selections and misses these controls (`app/scripts/smoke.mjs:157`).

### Should-fix — caught render-loop errors can still pass the smoke

**Evidence:** `app/scripts/smoke.mjs:47`, `:52`, `:56`, `:229`, `:235`; `app/src/components/error-boundary.tsx:53`.

The classifier correctly rejects every **uncaught** `pageerror`. However, React errors caught by the application's error boundary are logged through `console.error`. The smoke prints these messages and only records console failures matching `hermesDesktop … is not a function`. A caught `Maximum update depth exceeded` recurrence therefore creates no problem by itself.

The boundary DOM checks cover selected checkpoints, rather than every subsequent phase. In particular, after the tablet's final `assertWorkspaceAlive` at `app/scripts/smoke.mjs:198`, it resizes and opens Settings, checks only overlay padding, closes Settings, and never checks that page's boundary again. A workspace crash during that phase can leave a console error and a fallback on the tablet page while the independent phone context completes successfully.

**Reproduction:** exercised the exact extracted `watch()` function with a console event shaped like the boundary's render-loop log. Both `problems` and `pageErrors` remained empty. This verifies the missing error gate; it is not a claim that the patched build currently crashes.

Fail on recognized render-loop console errors or boundary reports as they occur, while allowing unrelated HTTP resource diagnostics. This would make the README's “No tolerance remains” and “fails whenever an error boundary shows” claims accurate (`app/README.md:350`, `:439`).

## Requested checks and validation

- **Typecheck:** `npm run typecheck` exited 0. A reverse patch dry-run against the installed dependency also succeeded, confirming that the committed hunk matches its patched contents without changing the file.
- **Patch correctness:** the guard at `app/patches/@assistant-ui+core+0.2.23.patch:16` calls a real module-local `shallowEqual`, defined at `app/node_modules/@assistant-ui/core/dist/subscribable/subscribable.js:4`. Its sibling uses the same helper at `:96`. Initial snapshots, changed top-level fields, and `SKIP_UPDATE` behavior remain valid for the actual thread-list/composer state shapes. The claimed disconnected thread-list path is confirmed at `app/node_modules/@assistant-ui/core/dist/runtime/api/thread-list-runtime.js:40` and `:97`.
- **Regression test:** `app/src/platform/assistant-ui-patch.test.ts:37` genuinely distinguishes patched and unpatched behavior. An in-memory negative control removing only the guard returned unequal unchanged snapshots; the installed patched module returned identical snapshots. Changed state remained observable in both versions. `npx vitest run src/platform` exited 0: **2 files, 20 tests passed**.
- **Classifier:** `app/scripts/smoke-classifier.mjs:22` maps every supplied error to a problem, with no message, phase, frame, or count exemption. `app/scripts/smoke.mjs:354` feeds those problems into its nonzero exit gate. `node --test scripts/smoke-classifier.test.mjs` exited 0: **5 tests passed**. The caught-error gap above is outside this classifier.
- **Layout scope:** the round-9 gutter and grid-row overrides are inside `@media (max-width: 767.98px)` (`app/src/platform/phone-layout.ts:36`). Drawer handlers require the upstream collapse query (`:72`), which is below 640px (`app/src/app/layout-constants.ts:30`). These adaptations do not apply at ≥768px. The 820px smoke gutter check is consistent with this (`app/scripts/smoke.mjs:231`).
- **README evidence:** the documented `page errors: 0 (none tolerated)` and final success text match the script's output and exit logic (`app/README.md:460`; `app/scripts/smoke.mjs:353`). The typing and transcript-switch assertions are present. Four historical successful smoke runs are plausible, but were not independently reproduced here; neither a fresh production build nor a live-gateway smoke was run for this review. Those runs also do not rule out the findings above.

## Verdict: REJECTED
