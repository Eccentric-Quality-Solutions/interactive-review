## Why

The 2026-09-28 review found three ways an edited file can be missing from the queue, or a
button can do nothing, with no message to the user. The first was reproduced: load and
Refresh start one `git cat-file` per tracked file at once, and under a 1024 file-descriptor
limit 2168 of 2500 fail with EMFILE. `getBaseline` reads each failure as "no baseline", so
those files silently drop out of review until the next Refresh.

## What Changes

- Load and Refresh read baselines, file contents and binary checks with bounded concurrency,
  reusing `mapWithLimit` and `HASH_CONCURRENCY` from `baselineGit.ts`. Closes todo #5.2.
- The panel's per-hunk Accept works when the file has no open document. Today it logs "no doc
  found" and returns; the panel's per-hunk Discard already opens the document.
- Typing a reviewing file's buffer back to its baseline no longer exits review while the
  buffer is unsaved. The file leaves review when the save reaches disk, through the existing
  change-event path.

## Capabilities

### New Capabilities
- `review-queue-integrity`: a changed file stays in the queue until disk matches its
  baseline, whatever the workspace size, and every panel action acts or says why it did not.

### Modified Capabilities
None.

## Non-goals

- Replacing per-file reads with `git cat-file --batch`. Faster, but the bug is the unbounded
  fan-out, and a cap fixes that with existing code.
- Speeding up load for large workspaces beyond what the cap gives.
- Rewriting integration tests to go through `executeCommand`.
- Preserving the executable bit on restore (todo #9).
- Changing how a saved edit back to baseline is handled; only the unsaved case changes.

## Impact

- `src/stateManager.ts`: `scanTrackedIntoState`, `readBatch`, `collectUntrackedFiles`.
- `src/baselineGit.ts`: export `mapWithLimit` and `HASH_CONCURRENCY`.
- `src/commands.ts`: `acceptHunkImpl` becomes async; `acceptHunk`, `acceptSelectionImpl`'s
  pure-removal fallback, and the panel, keybinding and CodeLens callers await it.
- `src/fileWatcher.ts`: `onDocumentChange` debounce skips the exit while the document is dirty.
- Tests: `stateManagerGit.test.ts`, `diffEditor.test.ts`, `saveVsExternalEdit.test.ts`,
  `scripts/mutation-check.mjs`.
