## 1. Baseline

- [x] 1.1 Run `npm test` and `npm run test:mutation`; record that both are green before any change
- [x] 1.2 Confirm the built behaviour already meets the `bulk-review-actions` spec and the unaffected `panel-undo` scenarios; note any that does not as a new bug, do not fix it yet

## 2. Restore exact bytes (design decision 1)

- [x] 2.1 Reproduce: extend `src/test/integration/undo.test.ts` so the open file has `files.trimTrailingWhitespace` on and the agent content has trailing spaces; confirm the undo fails or leaves altered bytes
- [x] 2.2 Write restored bytes with `vscode.workspace.fs.writeFile` in `editorUndoIO`; delete `survivesEditorWrite` and its tests
- [x] 2.3 Confirm the integration test shows exact bytes and the open buffer updated without a reload (it waits for the buffer; the delay is accepted, see design decision 1)
- [x] 2.4 Add a mutation that restores the editor-save path

## 3. Branch switch and queue clears (decisions 2 and 3)

- [x] 3.1 Reproduce: unit test where an action is recorded during `clearHunksOnBranchSwitch`'s awaits and is still in the history afterwards
- [x] 3.2 Bump `clearCount` again when the clear empties the queue
- [x] 3.3 Add a `StateManager` method that bumps `clearCount`, call it from the HEAD handler the moment a switch is seen, and unit-test the method's effect on the history
- [x] 3.4 Add mutations for both bumps

## 4. Messages and no-op entries (decisions 4, 5 and 7)

- [x] 4.1 Reproduce: unit test where the agent edits a file after an accept, then undo reports it in `keptOnDisk`
- [x] 4.2 Return early from `restoreDisk` when the action did not change the file; add a mutation
- [x] 4.3 Reproduce: unit test where an action on an unreadable file records an entry
- [x] 4.4 Use plain hash equality in `commit`'s no-op check; add a mutation
- [x] 4.5 Reproduce: unit test where more than `UNDO_LIMIT` actions still get "all N actions this session"
- [x] 4.6 Word Undo Everything from whether entries were dropped; add a mutation

## 5. Agent write during Discard All (decision 6)

- [x] 5.1 Reproduce: unit test where an agent rewrites an already-discarded file while Discard All is still running, and undoing Discard All overwrites it
- [x] 5.2 Stamp each file's `printAfter` when its part of the bulk action finishes; add a mutation

## 6. Verify and review

- [x] 6.1 Run `npm test`, `npm run test:mutation`, and `npm run test:integration` once; all green
- [x] 6.2 Rebuild and reinstall the vsix; ask Dave to try in his window: accept a hunk, undo; Discard All over two files (one open with format on save), undo; Accept All, Undo Everything
- [x] 6.3 One review pass reporting only correctness bugs against the specs in this change; at most one fix round after it
