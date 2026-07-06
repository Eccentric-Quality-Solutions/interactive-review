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
- [ ] 2.2 Implement `acceptSelection` in `src/commands.ts` — fold only the selected added lines into the baseline, leave the rest pending (deferred partial-accept follow-up)
- [x] 2.3 Implement `rejectSelection` — revert only the selected added lines to baseline; fall back to whole-hunk reject for pure-removal hunks
- [x] 2.4 Recompute hunks after a partial action; reuse the shared `applyEditAndAdvance` (counts/status/advance/exit stay correct) — done for the reject path
- [x] 2.5 Register `interactiveReview.rejectSelection` command + keybindings — `acceptSelection` still pending with 2.2
- [x] 2.6 Integration tests: partial reject of a mixed hunk; selection spanning a hunk boundary; partial reject completing the file (`partialReject.test.ts`) — partial-accept test pending with 2.2

## 3. Inline decorations surface (`inline-decorations-surface`)

- [x] 3.1 Add an `InlineDecorations` module: a `TextEditorDecorationType` for pending added lines, refreshed on `onStateChanged` and `onDidChangeTextDocument`
- [x] 3.2 Wire `openFile` so that when `useDiffEditor === false && showInlineDecorations === true` the file opens in the normal editor with decorations instead of the diff editor
- [x] 3.3 Extend `DiffCodeLensProvider` with a "Show N removed lines" CodeLens that peeks the baseline slice at the hunk
- [x] 3.4 Confirm per-hunk accept/reject CodeLens work identically in decorations mode (parity)
- [x] 3.5 Integration tests: added lines decorated in the normal editor; surface selection honors settings; accept clears the decoration

## 4. Trigger UX (`review-trigger-ux`)

- [ ] 4.1 Change `package.json` command `title`s: `interactiveReview.enable` → "Begin review", `interactiveReview.disable` → "End review" (keep command IDs stable)
- [ ] 4.2 Update the panel setup-screen text to read as beginning/ending a bounded review
- [ ] 4.3 Document `interactiveReview.enable` as the agent-callable begin-review hook (invocable via `executeCommand`); verify it opens a bounded session non-interactively
- [ ] 4.4 Integration test: begin-review snapshots + opens a session; end-review tears down; agent-invoked begin opens a walkable session

## 5. Finalize

- [ ] 5.1 Run unit + integration suites; keep the suite green (no new flakiness)
- [ ] 5.2 Update root `design.md` §4 (Phase 4 status) and resolve §5 #3 (primary surface) with the shipped decision
- [ ] 5.3 Manual UI pass: keyboard-walk a multi-file changeset to completion in both surfaces
