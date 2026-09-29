## Context

Three findings from the 2026-09-28 review, kept together because each is small and they share
one verification pass. Source proposal: `docs/code-review-2026-09-28.md`, round 1 items 1 to
3, as narrowed by the pragmatic review Dave approved.

- `StateManager.scanTrackedIntoState`, `readBatch` and `collectUntrackedFiles` each run one
  `Promise.all` over every file. The first spawns a `git cat-file` per tracked file. Measured
  on this machine: 2500 concurrent spawns, 2168 EMFILE failures under `ulimit -n 1024`.
  `BaselineGit.getBaseline` maps any failure to `undefined`, which the scan logs as "no
  baseline in index" and skips.
- `acceptHunkImpl` needs `findFileDocument` and returns when there is none. `discardHunkImpl`
  calls `openTextDocument`.
- `FileWatcher.onDocumentChange` recomputes hunks from the unsaved buffer after 50 ms and
  calls `exitReviewing` when none remain, while disk still differs.

## Goals / Non-Goals

**Goals:** the three requirements in `specs/review-queue-integrity/spec.md`, each with a test
that fails first and a mutation.

**Non-Goals:** as listed in the proposal. In particular no `cat-file --batch`, and no change
to how a tracked file whose baseline read fails for another reason is handled.

## Decisions

1. **Reuse `mapWithLimit` and `HASH_CONCURRENCY` (32).** Export both from `baselineGit.ts`;
   do not add a second limiter. Each of the three sites passes a function that already
   catches its own errors, so `mapWithLimit`'s rejection behaviour does not matter. One limit
   per call, not a shared global pool: a Refresh and an ignore sync overlapping gives 64 in
   flight, still far inside any real limit. `cat-file --batch` was considered and rejected
   for now: it removes the spawns entirely but needs a streaming parser and a new failure
   mode, for a speed gain nobody has asked for.
2. **`acceptHunkImpl` opens the document the way discard does,** and becomes async. Callers
   await it: `acceptHunk` returns the promise `recordUndo` already handles, and the lens,
   keybinding and panel callers attach `reportCommandFailure` or the panel's catch, as their
   discard counterparts do. `acceptSelectionImpl`'s pure-removal fallback awaits it.
   `lensTargetIsStale` still returns false for a closed document and lets the command check.
3. **The dirty gate goes in the debounce timer, not in `recomputeHunks`.** `recomputeHunks`
   also serves the disk-event paths, where disk is the truth and the exit is right. In the
   timer: when no hunks remain and `e.document.isDirty`, call `onStateChanged` and return.
   The save then fires a disk change; `handleDiskChange` finds the file reviewing and
   recomputes from disk, which is the existing exit path.

## Risks / Trade-offs

- [While the buffer is dirty and matches the baseline, the status bar still counts the file
  but the panel lists no row for it, since it has no hunks] → Accepted. It lasts until the
  save, one second with auto-save on, and it is the true state: the change is not on disk.
  Documented in the scenario "Typing back to baseline without saving".
- [Accept becomes async, so a second click can land before the first finishes] → The same
  window already exists for discard; `recordUndo` and the stale-hunk-id check handle it.
- [Integration tests call `acceptHunk` without awaiting and sleep] → Update those calls to
  `await`, which also removes their sleeps' job.
- [A cap of 32 makes a very large load slower than an unbounded fan on a machine with a high
  limit] → Measured 4.2 s for 2500 files unbounded; the cap is expected to be similar since
  spawn cost dominates. Checked in task 1.4.
