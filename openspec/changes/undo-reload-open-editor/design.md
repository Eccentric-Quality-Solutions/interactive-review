## Context

`editorUndoIO.writeFile` writes restored bytes with `workspace.fs.writeFile`. In a desktop
extension host that call goes to a local disk provider, not through the window's file
service, so an open text model reloads only when VS Code's file watcher reports the write.
Measured on 2026-09-27: 20–140 ms usually, stale for 15 s or more in about 1 undo in 20
(`todo.md` #8), with no known cause.

VS Code has no API to reload one document from disk. Every revert command acts on the
focused or active editor; `workbench.action.files.revert` reverts the active group's active
editor with `force: true`, which discards unsaved changes (checked in the 1.139 bundle).
A `WorkspaceEdit` file create reloads the model reliably but puts the create on the editor's
undo stack, so one Ctrl+Z deletes the file; it was tried and rejected in `panel-undo`.

## Goals / Non-Goals

**Goals:** an open, unmodified editor of a file undo wrote back shows the restored bytes
when undo returns; focus stays put; no editor with unsaved changes is ever reverted; when
the reload cannot be done the user is told.

**Non-Goals:** as in `proposal.md`.

## Decisions

1. **Reload inside `editorUndoIO.writeFile`, after the disk write.** It is the one place
   that knows a file's bytes were just written, and it already owns the editor side of
   undo. `restoreDisk` never writes a file whose editor had unsaved changes, so the dirty
   case is already excluded upstream; the check is repeated at the revert (decision 3).
2. **Reload by making the document active and running Revert File.** Find the document's
   tab (`window.tabGroups`) for its view column, `showTextDocument(doc, { viewColumn,
   preserveFocus: true, preview: false })`, run `workbench.action.files.revert`, then show
   the previously active editor again with `preserveFocus: true`. `preserveFocus` keeps
   keyboard focus in the panel; showing the document in its own column does not open a
   second tab. Revert reads the file through the window's file service, so it does not
   depend on the watcher. Alternatives: `WorkspaceEdit.createFile` (Ctrl+Z deletes the
   file), editor save (save participants alter the bytes), waiting for the watcher (the
   bug).
3. **Revert only if, right before the call, the active text editor's document is this
   document and it has no unsaved changes.** Revert File discards unsaved changes in
   whatever editor is active; `preserveFocus` does not activate another editor group, so
   a document in a group other than the active one will fail this check. That is the
   safety property; it gets a unit test and a mutation.
4. **When revert is skipped, report the file.** `UndoIO.writeFile` returns whether an open
   editor may still show old content; `undo` collects those paths in `UndoResult`
   (`staleEditors`) and `undoReport` warns: the file is open with its old content, run
   File: Revert File on it. A skipped revert is reported even if the watcher happens to
   catch up; comparing buffer text with bytes would need EOL, BOM and encoding handling for
   a message.

## Risks / Trade-offs

- [The editor visibly switches to the file and back] → only for files open in the active
  group; brief; accepted in exchange for a correct buffer.
- [A reload from disk may itself be undoable in the editor] → VS Code keeps a reload on the
  text undo stack, so Ctrl+Z brings the old text back into the buffer as an unsaved change.
  That does not touch the disk, which is what the spec requires; the integration test
  checks it.
- [Undo of Discard All over many open files switches editors once per file] → accepted.
- [`preserveFocus` behaviour differs across VS Code versions] → the integration test checks
  the active editor and that nothing else was reverted; if `showTextDocument` with
  `preserveFocus` does not make the document active in its group, stop and report.
