# Panel Undo

## Purpose

Let the reviewer take back any accept or discard from the panel, back to the start of the
session, restoring both the review queue and the files on disk without ever overwriting
work done since.

## Requirements

### Requirement: Every accept and discard is one undoable action

The extension SHALL record each accept and discard the user performs (hunk, selected
lines, file, Accept All, Discard All), whether from the panel, a CodeLens or a keybinding,
as exactly one entry in the session's undo history. An action that changed neither a
review entry nor a file SHALL NOT be recorded.

#### Scenario: A hunk accept is one entry
- **WHEN** the user accepts a hunk
- **THEN** the undo history gains one entry naming that hunk's file

#### Scenario: Discard All is one entry
- **WHEN** the user runs Discard All over several files
- **THEN** the history gains one entry covering all of them, not one per file

#### Scenario: A no-op action is not recorded
- **WHEN** an accept or discard changes nothing, including on a file that cannot be read
- **THEN** the history is unchanged

### Requirement: The Undo button offers what the history holds

The panel SHALL show an Undo button in its header and on the review-complete screen while
the history is not empty, and SHALL hide it otherwise. Clicking it SHALL open a modal
offering Undo Last; Undo Through the most recent Accept All or Discard All, when that
undoes more than Undo Last; and Undo Everything, when that undoes more than the choice
before it. Dismissing the modal SHALL undo nothing. The modal's description of Undo
Everything SHALL be true when older entries have been dropped from the history.

#### Scenario: Choosing a kind of undo
- **WHEN** the history holds an accept, then an Accept All, then a discard, and the user
  picks Undo Through Accept All
- **THEN** the discard and the Accept All are undone and the first accept is not

#### Scenario: Dismissed dialog
- **WHEN** the user closes the Undo modal without choosing
- **THEN** nothing is undone

#### Scenario: History past its limit
- **WHEN** more actions were recorded than the history keeps
- **THEN** the modal describes Undo Everything as undoing the last N actions, not all
  actions this session

### Requirement: Undo restores the review entry and the file

Undoing an action SHALL put back each affected file's review entry, in memory and in the
baseline repository so a reload agrees, and SHALL put back the file's exact bytes on disk
as they were before the action. A file the action created SHALL be moved to the trash;
a file it deleted SHALL be recreated. An open editor for a restored file SHALL show the
restored content once VS Code's file watcher reports the change. Save participants (format on save, whitespace
trimming) SHALL NOT alter the restored bytes. A restored entry with nothing left to review
SHALL be resolved rather than left hidden.

#### Scenario: Undo a discard of an open file with format on save
- **WHEN** the user discards an agent's edit to a file open in an editor with
  `editor.formatOnSave` or `files.trimTrailingWhitespace` on, then undoes
- **THEN** the file holds the agent's exact bytes, the editor shows them, and the file is
  back in review

#### Scenario: Undo Accept All
- **WHEN** the user runs Accept All and then undoes it
- **THEN** every accepted file is back in review against its original baseline, and a
  reload shows the same queue

#### Scenario: Undo a discard that deleted a new file
- **WHEN** the user discards a file the agent created, then undoes
- **THEN** the file exists again with its content and is back in review as new

### Requirement: Undo never overwrites later work

Undo SHALL leave a file's current content alone when it differs from what the action left,
or when an editor holds unsaved changes to it, and SHALL say so. It SHALL NOT report a file
as left alone when the action never changed that file's content. It SHALL treat an agent
write made while a bulk action was still running as later work.

#### Scenario: File edited after a discard
- **WHEN** the user discards a file, the agent then rewrites it, and the user undoes
- **THEN** the agent's new content stays on disk and the user is told the file was left

#### Scenario: Agent edits after an accept
- **WHEN** the user accepts a file, the agent then edits it, and the user undoes the accept
- **THEN** the file is back in review against its original baseline and no "left as it is"
  message is shown

#### Scenario: Agent write during Discard All
- **WHEN** the agent rewrites a file that Discard All has already discarded while Discard
  All is still processing other files, and the user then undoes Discard All
- **THEN** the agent's write stays on disk

### Requirement: The history belongs to one session and one queue

The history SHALL be emptied by a window reload, End review, Begin review, and any clear
of the review queue (a branch switch with clear-on-switch on, or Clear Hunks). An undo in
progress when one of these happens SHALL stop and say the rest was not undone. An action
recorded while a queue clear is running SHALL NOT survive the clear.

#### Scenario: Branch switch during an earlier clear
- **WHEN** a second branch switch is detected while the first switch's clear is still
  running, and the user clicks Undo
- **THEN** no entry from before the switches is offered or undone

#### Scenario: Accept during a clear
- **WHEN** the user accepts a file while a queue clear is running
- **THEN** after the clear, that accept is not in the history

### Requirement: Existing single-undo behaviour is kept

Panel Undo SHALL NOT change the editor-level undo guarantees in `review-keybindings`
("Reject is a single-gesture, single-undo action") and `partial-hunk-actions` ("Partial
reject is a single undo"): each reject and partial reject SHALL remain one edit that a
single editor undo reverses.

#### Scenario: Editor undo after a reject
- **WHEN** the user rejects a hunk and presses the editor's undo once
- **THEN** the rejected lines are restored in one step, as before panel Undo existed
