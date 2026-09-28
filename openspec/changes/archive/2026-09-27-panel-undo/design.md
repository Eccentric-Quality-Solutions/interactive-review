## Context

Panel Undo and the bulk confirmations are already built and uncommitted. The pieces:

- `src/undoHistory.ts`: the history. `capture` snapshots each file's review entry and bytes
  before an action; `commit` records hashes before and after, keeping the "before" bytes
  only when the action changed the file. `undo` walks entries newest first and calls
  `restoreDisk` then `StateManager.restoreFile` per file. Entries are scoped to
  `session/clearCount`.
- `src/commands.ts`: each exported accept/discard is a wrapper that runs its `*Impl` inside
  `recordUndo`, so nested calls stay one entry. Also `undoChoices`, `confirmAndUndo`,
  `undoReport`, `confirmAndAcceptAll`, and `editorUndoIO` (undo's disk, editor and trash
  effects, installed once by `registerCommands`).
- `StateManager.restoreFile` writes the entry and queues the matching baseline write;
  `clearCount` is bumped when `clearHunksOnBranchSwitch` starts.

Review found seven correctness bugs, listed in `tasks.md`. Earlier fix rounds added
mechanisms that caused later bugs, so this design fixes each with the least new code.

## Goals / Non-Goals

**Goals:** make the seven failing scenarios in `specs/panel-undo` pass, each proven by a
test that fails first; keep every existing test and spec requirement green.

**Non-Goals:** the Non-goals in `proposal.md`. No refactors beyond what a fix needs.

## Decisions

1. **Restore bytes with `vscode.workspace.fs.writeFile`, not an editor save.** An editor
   save runs save participants and re-encodes, so the bytes cannot be guaranteed.
   `workspace.fs.writeFile` writes exact bytes, but straight to disk from the extension host,
   so an open editor picks them up only when VS Code's file watcher reports the change.
   Delete `survivesEditorWrite` and the editor branch.
   *Measured:* the buffer usually catches up 20–100 ms after undo returns; in the test
   instance it sometimes stayed stale (see Risks). Rejected: a `WorkspaceEdit` file create
   reloads the buffer at once, but puts the create on the editor's undo stack, so one Ctrl+Z
   deletes the file.
2. **Bump `clearCount` when the HEAD change is seen**, as well as when the clear starts, via
   a small `StateManager` method called from the HEAD handler. This restores what the
   removed immediate `undoHistory.clear()` did, through the counter that is already tested.
3. **Bump `clearCount` again when the clear empties the queue**, so an action recorded
   during the clear's awaits is dropped with it.
4. **`restoreDisk` returns early when the action did not change the file**
   (`printBefore === printAfter`): there is nothing to write, so nothing to report.
5. **`commit`'s no-op check uses plain equality of hashes**, so unreadable-before and
   unreadable-after count as unchanged. `samePrint`'s stricter rule stays in `restoreDisk`,
   where it keeps undo from writing over content it cannot see.
6. **Record each file's "before" and "after" around that file's part of a bulk action.**
   Discard All's loop takes `start`/`done` callbacks from `recordUndo`: `start` re-takes the
   file's snapshot as its turn begins, so an agent write before then is what the discard
   overwrote and undo puts it back; `done` stamps `printAfter`, so a write after is later
   work undo keeps. Accept All's loop has no await, so it needs neither. Alternative
   considered: one entry per file for bulk actions, rejected because Undo Last must undo
   the whole bulk action.
7. **Undo Everything text** comes from whether the history dropped entries; `UndoHistory`
   exposes that as a flag.

## Risks / Trade-offs

- [Decision 1 leaves an open buffer to the file watcher] → accepted for this change. In the
  test instance a buffer stayed stale for 15 s or more in about 1 undo in 20, whether or
  not the undo came after a pause or a formatter ran. The disk and the queue are right
  either way, and a stale buffer is not dirty so a save hits VS Code's "file is newer"
  check; the risk left is a hunk command on the stale text. Tracked in `todo.md` #8, to be
  fixed by a separate change that reloads the open document.
- [Decision 6 threads a callback through two `*Impl` loops] → limited to the two bulk
  functions; the unit test drives an agent write mid-loop.
- [The HEAD-handler call in decision 2 is not reachable from unit tests] → the counter's
  effect is unit-tested; the call site is covered only by the branch-switch integration
  test, which is currently skipped. Say so in the task report.
