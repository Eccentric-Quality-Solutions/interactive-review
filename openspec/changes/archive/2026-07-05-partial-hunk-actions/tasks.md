## 1. Range logic in diffEngine

- [x] 1.1 Add `splitHunkByRange(hunk, selStartLine, selEndLine)` to `src/diffEngine.ts` returning `{ hasAddedInRange, addedStartIdx, addedEndIdx }` — intersect the 0-based selection range with the hunk's added-line span `[newStart-1 .. newStart-1+newLines-1]`; `hasAddedInRange` is false for `newLines === 0` or an empty intersection
- [x] 1.2 Unit tests for `splitHunkByRange`: selection inside the added span, selection spanning a hunk boundary (context clamped), selection covering no added lines, and pure-removal hunk (`newLines === 0`)

## 2. Partial reject command in commands.ts

- [x] 2.1 Implement `rejectSelection` in `src/commands.ts` mirroring `discardHunk`: resolve the hunk from the active editor + selection start, call `splitHunkByRange`, delete document lines `[newStart-1+addedStartIdx .. newStart-1+addedEndIdx)` via one `WorkspaceEdit` (with `markSelfEdit`), save
- [x] 2.2 Handle fallbacks/signals: `hasAddedInRange === false` from a pure-removal hunk → delegate to `discardHunk` (whole hunk); no added lines in range on an add-bearing hunk → no-op + `log`; selection spanning >1 hunk → resolve the start hunk + `log` the ignored hunks
- [x] 2.3 Reuse the existing `discardHunk` tail: recompute hunks; `remainingHunks === 0 → exitReviewing` (incl. new-file `unlink`) else `revealNextHunk`; confirm the action is a single undo

## 3. Registration

- [x] 3.1 Register `interactiveReview.rejectSelection` in `src/extension.ts` and contribute the `command` + a default `keybinding` in `package.json`, gated by `when: "interactiveReview.inReview && editorTextFocus"`

## 4. Tests + finalize

- [x] 4.1 Integration tests: partial reject of a mixed hunk (rest stays pending); selection spanning a hunk boundary; pure-removal fallback to whole-hunk; multi-hunk selection resolves the start hunk only; a partial reject resolving the file's last change completes/advances; single-undo restores the reverted lines
- [x] 4.2 Run unit + integration suites green (no new flakiness); manual pass: select a sub-range of added lines in a mixed hunk, reject, verify counts, advance, and single-undo
