# Review rounds 9–10 — Astra

Reviewed `a78fc2a` and `f794485` against their parent, with HEAD at `f794485`. No tracked source files were modified.

## Findings (severity order)

No blocker or should-fix findings.

### Nit — session-switch success message can describe a failed check

**Evidence:** `app/scripts/smoke.mjs:179`, `:185`, and `:189` append failures but continue; `app/scripts/smoke.mjs:194` unconditionally prints “transcripts followed.” A missing expected transcript or a still-visible wrong transcript can therefore produce a success-looking progress line. This is particularly confusing in the negative-control excerpt at `app/README.md:343`, where that line precedes a later timeout.

Only print this success line if the function added no problems, or describe it as completion of the attempted sequence. This does **not** weaken the exit gate: `app/scripts/smoke.mjs:354`–`:358` still collects the failures and exits 1.

## Verification

1. **Dependency patch is valid.** `app/patches/@assistant-ui+core+0.2.23.patch:16` uses a function already declared in the same module at `app/node_modules/@assistant-ui/core/dist/subscribable/subscribable.js:4`; no import is missing. The sibling subject uses that same helper at `:96`. The new guard preserves the previous identity for shallow-equal object snapshots, accepts changed fields, retains the `SKIP_UPDATE` behavior, and leaves dirty-state clearing intact. The runtime's fixed-shape object snapshots fit this comparison. The installed package is version 0.2.23 and its exports resolve to the patched dist files.

2. **The claimed thread-list mechanism matches the code.** `app/node_modules/@assistant-ui/core/dist/runtime/api/thread-list-runtime.js:6` builds a fresh wrapper; `:40` wraps it in a lazy subject; `:99` subscribes directly to the core. Thus the subject remains disconnected. `app/node_modules/@assistant-ui/core/dist/store/runtime-clients/useSubscribable.js:4` passes runtime subscribe/getState to tap's external-store hook.

3. **The regression test distinguishes patched from unpatched behavior.** `app/src/platform/assistant-ui-patch.test.ts:37` compares references from consecutive disconnected reads: the original unconditional assignment necessarily fails it. The changed-field checks at `:44` and `:50` cover disconnected and connected updates. Ran `npx vitest run src/platform`: **2 files, 20 tests passed**, exit 0. Additionally evaluated the actual dependency module in memory with and without the guard: unchanged disconnected snapshots were unequal without it and identical with it. This negative control changed no dependency files.

4. **No page-error allowance remains.** `app/scripts/smoke-classifier.mjs:22` maps every input error to a problem; the regex only changes its label. There is no count, stack-site, phase, or message exemption. `app/scripts/smoke.mjs:47` captures every page error, and `:354`–`:358` makes any such error fatal. The formerly tolerated shape, a single occurrence, the markDirty variant, and unrelated errors are covered by the classifier tests. Ran `node --test scripts/smoke-classifier.test.mjs`: **5 tests passed**, exit 0. Console errors are logged and bridge errors additionally fail; ordinary console/resource messages are distinct from uncaught page errors, consistent with the README's logged HTTP 409s.

5. **Phone CSS is scoped below 768px.** Both round-9 additions are inside the media block at `app/src/platform/phone-layout.ts:36`–`:42`. Neither changes layout at widths ≥768px. The `.auto-rows-fr` class is currently used only by the gateway connection-mode grid. Drawer pointer handling is gated at `:72` by the existing, narrower 639.98px collapse query (`app/src/app/layout-constants.ts:34`). The smoke's 820px overlay-gutter check at `app/scripts/smoke.mjs:229`–`:233` provides a representative tablet assertion.

6. **README gate claims are consistent with the scripts.** The test counts at `app/README.md:265`–`:276` match this review's runs. The final smoke output at `app/README.md:446`–`:462` matches the script's output and exit logic: reaching `SMOKE OK` requires an empty problem list and zero captured page errors. Four historical smoke executions cannot be independently established from source inspection; I did not rerun the gateway-dependent browser smoke, build, or typecheck. The recorded runs are therefore assessed for consistency, not independently reproduced. The unconditional intermediate session-switch message is the nit above, not evidence that the final gate can pass despite a recorded failure.

## Verdict: APPROVED_WITH_NITS
