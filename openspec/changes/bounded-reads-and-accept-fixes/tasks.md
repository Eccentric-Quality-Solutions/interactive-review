## 0. Baseline

- [ ] 0.1 Run `npm test` and `npm run test:mutation`; record that both are green before any change

## 1. Bounded reads on load and Refresh

- [ ] 1.1 Reproduce: in `stateManagerGit.test.ts`, following the `ulimit -n` child-process pattern in `baselineGitHardening.test.ts` ("snapshotBatch … under ulimit"), baseline 500 files, edit all of them on disk, run `rebuildState` under `ulimit -n 256`, and assert all 500 are reviewing. Confirm it fails on the current code
- [ ] 1.2 Export `mapWithLimit` and `HASH_CONCURRENCY` from `baselineGit.ts`; use them in `scanTrackedIntoState`, `readBatch` and `collectUntrackedFiles`. Confirm 1.1 passes
- [ ] 1.3 Add a mutation per site that swaps `mapWithLimit` back to `Promise.all`; each must be killed by 1.1 or by a concurrency-counting unit test added for that site
- [ ] 1.4 Time `rebuildState` over 2500 files before and after; report both. Remove todo #5.2

## 2. Panel hunk Accept with no open document

- [ ] 2.1 Reproduce: give the vscode mock an `openTextDocument` that returns a mock document, and add a unit test that calls `acceptHunk` for a file with no entry in `workspace.textDocuments` and asserts the baseline advanced. Confirm it fails
- [ ] 2.2 Make `acceptHunkImpl` async and open the document as `discardHunkImpl` does; await it in `acceptHunk` and `acceptSelectionImpl`'s pure-removal fallback; attach `reportCommandFailure` in the lens and keybinding callers and keep the panel's catch. Confirm 2.1 passes
- [ ] 2.3 Mutation: restore the "no doc found, skip" early return
- [ ] 2.4 Change the integration tests that call `acceptHunk` unawaited (`diffEditor`, `hunkNavigation`, `deleteRestore`, `crossFileAdvance`, `reviewComplete`, `preexistingFiles`) to await it; drop a sleep only where it existed to wait for the accept

## 3. No exit on an unsaved buffer that matches the baseline

- [ ] 3.1 Reproduce: in `saveVsExternalEdit.test.ts`, put a file in review, edit its buffer back to the baseline without saving, wait past the 50 ms debounce with `whenIdle`, and assert it is still reviewing; then save and assert it left review. Confirm the first assertion fails
- [ ] 3.2 In `FileWatcher.onDocumentChange`'s timer, when no hunks remain and the document is dirty, call `onStateChanged` and return without `exitReviewing`. Confirm 3.1 passes
- [ ] 3.3 `fileWatcher.ts` does not load under the unit mock, so this guard is an integration test: add it to the integration-guard table in `docs/test-strategy.md` and check by hand that removing the `isDirty` check fails 3.1. If a source-text guard in `reloadEqualsMemory.test.ts` would be as reliable as the existing three there, add it and its mutation instead

## 4. Verify and review

- [ ] 4.1 Run `npm test`, `npm run test:mutation`, and `npm run test:integration` once; all green, or any failure checked for inotify starvation per `docs/test-strategy.md`
- [ ] 4.2 Rebuild and reinstall the vsix and check `buildInfo.json`. Dave tries in his window: close a reviewed file's diff tab and accept one of its hunks from the panel; type a reviewed file back to its baseline and see it stay listed until saved
- [ ] 4.3 One review pass reporting only correctness bugs against `specs/review-queue-integrity/spec.md`; at most one fix round after it
- [ ] 4.4 Ask Dave whether to bump `version` to 0.1.1
