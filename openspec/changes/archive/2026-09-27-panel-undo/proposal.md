## Why

The panel's Accept All and Discard All act on the whole queue in one click, and until now
nothing in the panel could reverse an accept or a discard. The Undo feature and the bulk
confirmations were built without a spec (uncommitted, 2026-09-27). Review found correctness
bugs in them, and fixing those without a contract kept introducing new ones. This change
writes the contract down and plans the fixes against it.

## What Changes

- Header buttons read **Accept All** and **Discard All**; both ask for confirmation in a
  modal before acting. The per-row ✓ / ↺ buttons are always visible, not only on hover.
- A **↶ Undo** button in the panel header and on the review-complete screen, shown while
  there is something to undo. It opens a modal offering: Undo Last, Undo Through the most
  recent Accept All / Discard All, and Undo Everything.
- Every accept and discard (hunk, selected lines, file, Accept All, Discard All), from the
  panel, a CodeLens or a keybinding, is one undoable action.
- Undo puts back the review entry and the file's bytes on disk. It never overwrites a file
  changed since the action or one with unsaved editor changes, and says what it left.
- Fix the seven known correctness bugs (see tasks).

## Capabilities

### New Capabilities
- `panel-undo`: undoing accepts and discards from the panel, what each undo choice covers,
  how files and the review queue are restored, and when the history is emptied.
- `bulk-review-actions`: Accept All / Discard All labels and confirmation, and always-visible
  per-row actions.

### Modified Capabilities
None. The editor-level single-undo requirements in `review-keybindings` ("Reject is a
single-gesture, single-undo action") and `partial-hunk-actions` ("Partial reject is a single
undo") are unchanged and must keep holding; `panel-undo` states that explicitly.

## Non-goals

- Two actions within milliseconds of each other: an action finishing during an undo, or a
  CodeLens click while Discard All runs. Tracked as `todo.md` #6.
- Following renames made after an action (`todo.md` #6); the watcher's self-edit mark
  (`todo.md` #7).
- Memory use and speed, unless measured to be a problem on a real queue.
- Persisting the history across a window reload.
- Undoing a whole-file discard of a file that had unsaved typing.

## Impact

- Code: `src/undoHistory.ts` (new), `src/commands.ts` (recorded wrappers, undo dialog and
  report, Accept All confirmation, `editorUndoIO`), `src/stateManager.ts` (`restoreFile`,
  `clearCount`), `src/reviewPanel.ts`, `src/extension.ts`, `src/textFile.ts`,
  `media/panel.js`, `media/panel.css`.
- Tests: `src/test/undoHistory.test.ts`, `src/test/acceptAllConfirm.test.ts`,
  `src/test/integration/undo.test.ts`, `scripts/mutation-check.mjs`.
- Replaces `docs/undo-spec.md`, which is deleted.
