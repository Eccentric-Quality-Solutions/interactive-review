## Why

Panel Undo writes a file's exact bytes with `workspace.fs.writeFile`, which goes straight to
disk from the extension host. An open editor shows them only when VS Code's file watcher
reports the write. In the test instance an open buffer stayed stale for 15 s or more in
about 1 undo in 20 (`todo.md` #8). A hunk command on the stale text folds the wrong baseline
in, silently.

## What Changes

- After undo writes a file that is open in an editor with no unsaved changes, the extension
  reloads that document from disk itself: it brings the document forward without taking
  focus, runs VS Code's Revert File on it, and puts the previously active editor back.
- Revert runs only when the active editor is that document, still without unsaved changes,
  at the moment of the call; Revert File discards unsaved changes, so it must never reach
  another editor.
- When the reload cannot be done (the document ends up not active, for example in another
  editor group) and the buffer still differs from disk, undo tells the user the file is open
  with its old content and to run File: Revert File.
- `panel-undo`'s "Undo restores the review entry and the file" returns to: an open editor
  shows the restored content when the undo finishes.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `panel-undo`: "Undo restores the review entry and the file" — an open, unmodified editor
  shows the restored content when the undo finishes, or the user is told it does not.

## Non-goals

- Documents with unsaved changes: undo already leaves those files as they are on disk.
- Files undo moves to the trash: an open editor of such a file keeps VS Code's own
  handling.
- Keeping which tab is in front in editor groups other than the active one.
- Any other way of writing the bytes. Rejected: `WorkspaceEdit.createFile` with overwrite
  (the create goes on the editor's undo stack, so one Ctrl+Z deletes the file) and an editor
  save (save participants alter the bytes). See the archived `panel-undo` design, decision 1.
- Discard's own editor save and format on save (a separate, older behaviour).

## Impact

- Code: `src/commands.ts` (`editorUndoIO`, `undoReport`), `src/undoHistory.ts` (`UndoIO`,
  `UndoResult`).
- Tests: `src/test/integration/undo.test.ts`, `src/test/undoHistory.test.ts`,
  `scripts/mutation-check.mjs`.
- Closes `todo.md` #8.
