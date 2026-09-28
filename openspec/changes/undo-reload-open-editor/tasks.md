## 1. Baseline

- [ ] 1.1 Run `npm test` and `npm run test:mutation`; record that both are green before any change

## 2. Reproduce the stale buffer deterministically

- [ ] 2.1 In `src/test/integration/undo.test.ts`, add a test that sets `files.watcherExclude` for the test file, discards it while open, undoes, and asserts the buffer shows the restored bytes when undo returns; confirm it fails. If excluding the file also stops the review from seeing the agent's edit, stop and report

## 3. Reload the open document (design decisions 1–3)

- [ ] 3.1 In `editorUndoIO.writeFile`, after the disk write: find the open document and its view column, show it with `preserveFocus`, run `workbench.action.files.revert` only if the active text editor is that document with no unsaved changes, then show the previously active editor again
- [ ] 3.2 Confirm the test from 2.1 passes, and extend it: the previously active editor is active again, and the editor's undo afterwards leaves the file on disk unchanged. If `showTextDocument` with `preserveFocus` does not make the document active, stop and report
- [ ] 3.3 Unit test with the vscode mock: when the active editor after showing is another document with unsaved changes, revert is not called; add a mutation that removes the check

## 4. Tell the user when the reload was skipped (decision 4)

- [ ] 4.1 Reproduce: unit test where `writeFile` reports a skipped reload and `undoReport` says nothing about it
- [ ] 4.2 `UndoIO.writeFile` returns whether an open editor may still show old content; `undo` collects `staleEditors`; `undoReport` warns with the file names and "File: Revert File"; add a mutation

## 5. Verify and review

- [ ] 5.1 Run `npm test`, `npm run test:mutation`, and `npm run test:integration` once; all green
- [ ] 5.2 Rebuild and reinstall the vsix; Dave tries in his window: open a file, discard it from the panel, undo; the editor shows the agent's content at once and the panel keeps focus
- [ ] 5.3 One review pass reporting only correctness bugs against the spec in this change; at most one fix round after it
- [ ] 5.4 Remove `todo.md` #8
