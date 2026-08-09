## 1. Review commands + keyboard walk (`review-keybindings`)

- [x] 1.1 Add a `resolveHunkAtCursor(editor)` helper (compute hunks for the active editor's doc, find the hunk containing the cursor) in `src/commands.ts`
- [x] 1.2 Register palette commands `interactiveReview.acceptHunk` / `rejectHunk` / `acceptFile` / `rejectFile` wrapping the existing accept/reject functions, resolving target from the active editor + cursor
- [x] 1.3 Implement `interactiveReview.nextHunk` / `prevHunk`: move to the adjacent pending hunk in the active editor; at the end call the existing `reviewPanel.advanceToNextFile`
- [x] 1.4 Set a context key `interactiveReview.inReview` via `setContext` when the active editor is a reviewing file (update on `onStateChanged` + active-editor change)
- [x] 1.5 Contribute `commands` (with titles) and default `keybindings` in `package.json`, gated by `when: "interactiveReview.inReview && editorTextFocus"`; add `enablement`/`when` so commands are hidden when review is disabled
- [x] 1.6 Give the panel's reject affordance equal weight to accept (symmetry) and confirm both are single-undo
- [x] 1.7 Integration tests: accept/reject via command; next advances across files; keybinding context gating

## 2. Partial-hunk actions (`partial-hunk-actions`)

- [x] 2.1 Add range-scoped resolution in `src/diffEngine.ts`: given a hunk + a line range, split into applied vs remaining added lines (`splitHunkByRange`)
- [x] 2.2 Implement `acceptSelection` in `src/commands.ts` — fold only the selected added lines into the baseline, leave the rest pending
- [x] 2.3 Implement `rejectSelection` — revert only the selected added lines to baseline; fall back to whole-hunk reject for pure-removal hunks
- [x] 2.4 Recompute hunks after a partial action; reject path reuses the shared `applyEditAndAdvance`, accept path recomputes/advances/exits inline (counts/status/advance/exit stay correct)
- [x] 2.5 Register `interactiveReview.rejectSelection` + `interactiveReview.acceptSelection` commands + keybindings
- [x] 2.6 Integration tests: partial reject (`partialReject.test.ts`) and partial accept (`partialAccept.test.ts`) — mixed hunk, hunk-boundary spans, multi-hunk selection, pure-removal fallback, context-only no-op, file-completing action

## 3. Inline decorations surface (`inline-decorations-surface`) — DESCOPED 2026-07-12

**These tasks were completed, then reverted. The surface does not ship.** Built in
`3548dd4` (2026-07-05), removed entirely in `bb7034c` (2026-07-12): a decorations-only
surface cannot render removed lines on stable APIs, which fails the core review use
case. The `InlineDecorations` module, the `useDiffEditor` / `showInlineDecorations`
settings, and the "Show N removed lines" peek are all gone from the codebase.

Rationale: root [`docs/design.md`](../../../docs/design.md) §4e ("Update (2026-07-12):
decorations surface removed entirely") and §5 #3. The `inline-decorations-surface` delta
spec was deleted rather than synced — the capability never reached `openspec/specs/`, so
it correctly leaves no trace in the spec baseline.

- ~~3.1 Add an `InlineDecorations` module: a `TextEditorDecorationType` for pending added lines, refreshed on `onStateChanged` and `onDidChangeTextDocument`~~
- ~~3.2 Wire `openFile` so that when `useDiffEditor === false && showInlineDecorations === true` the file opens in the normal editor with decorations instead of the diff editor~~
- ~~3.3 Extend `DiffCodeLensProvider` with a "Show N removed lines" CodeLens that peeks the baseline slice at the hunk~~
- ~~3.4 Confirm per-hunk accept/reject CodeLens work identically in decorations mode (parity)~~
- ~~3.5 Integration tests: added lines decorated in the normal editor; surface selection honors settings; accept clears the decoration~~

## 4. Trigger UX (`review-trigger-ux`)

- [x] 4.1 Change `package.json` command `title`s: `interactiveReview.enable` → "Begin review", `interactiveReview.disable` → "End review" (keep command IDs stable)
- [x] 4.2 Update the panel setup-screen text to read as beginning/ending a bounded review — setup button "Enable for this project" → "Begin review"; settings Danger Zone → "End review" with session-teardown wording
- [x] 4.3 Document `interactiveReview.enable` as the agent-callable begin-review hook (invocable via `executeCommand`); verify it opens a bounded session non-interactively — audit found the path already dialog-free and panel-independent, so this is documentation (README "Starting a review from an agent" + a contract doc-comment on `enableReview` recording the non-interactivity requirement)
- [x] 4.4 Integration test: begin-review snapshots + opens a session; end-review tears down; agent-invoked begin opens a walkable session — 5 tests in `triggerUx.test.ts` (also: titles/ID stability, and repeat-begin idempotence)

## 5. Finalize

- [x] 5.1 Run unit + integration suites; keep the suite green (no new flakiness) — 77 unit / 105 integration passing, 1 pending, 0 failing (2026-08-09, after 4.1–4.4)
- [x] 5.2 Update root `design.md` §4 (Phase 4 status) and resolve §5 #3 (primary surface) with the shipped decision — §4g rewritten 2026-08-09 (was stale: claimed DONE at 2026-07-05, before the decorations removal and with trigger UX unstarted); §5 #3 already RESOLVED in favor of the diff editor as sole surface
- [x] 5.3 Manual UI pass: keyboard-walk a multi-file changeset to completion in the diff editor (originally "in both surfaces" — there is one surface since §3 was descoped) — automated in real VS Code 1.132 as `keyboardWalk.test.ts`: 3 files × 2 hunks, driven only through the keybinding-bound commands (which resolve from `activeTextEditor`), mixed accept/reject, walked to an empty queue in exactly 6 steps. **Visual/aesthetic confirmation still needs a human** — screenshot capture under Xvfb yields a blank frame, so rendering (red/green, CodeLens placement, panel styling) was not verified by eye
