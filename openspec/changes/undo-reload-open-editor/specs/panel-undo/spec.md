## MODIFIED Requirements

### Requirement: Undo restores the review entry and the file

Undoing an action SHALL put back each affected file's review entry, in memory and in the
baseline repository so a reload agrees, and SHALL put back the file's exact bytes on disk
as they were before the action. A file the action created SHALL be moved to the trash;
a file it deleted SHALL be recreated. An open editor with no unsaved changes for a file
whose bytes undo wrote back SHALL show the restored content when the undo finishes, without
taking focus from where it was and without adding anything to the editor's undo stack that
would change the file on disk; when that cannot be done, the user SHALL be told which files
are open with their old content. Undo SHALL NOT revert, reload or otherwise touch an editor
holding unsaved changes. Save participants (format on save, whitespace trimming) SHALL NOT
alter the restored bytes. A restored entry with nothing left to review SHALL be resolved
rather than left hidden.

#### Scenario: Undo a discard of an open file with format on save
- **WHEN** the user discards an agent's edit to a file open in an editor with
  `editor.formatOnSave` or `files.trimTrailingWhitespace` on, then undoes
- **THEN** the file holds the agent's exact bytes, the editor shows them when the undo
  finishes, and the file is back in review

#### Scenario: Focus and editor undo after an undo
- **WHEN** the user undoes a discard from the panel while the file is open in an editor
- **THEN** focus stays where it was, the previously active editor is active again, and
  pressing the editor's undo in that file afterwards does not delete the file or change it
  on disk

#### Scenario: An editor with unsaved changes is never reverted
- **WHEN** another file's editor holds unsaved changes while the user undoes a discard of an
  open file
- **THEN** that editor's unsaved changes are still there

#### Scenario: An open editor that cannot be reloaded
- **WHEN** undo writes back a file whose open editor it cannot reload, and the editor still
  shows the old content
- **THEN** the user is told that file is open with its old content and how to reload it

#### Scenario: Undo Accept All
- **WHEN** the user runs Accept All and then undoes it
- **THEN** every accepted file is back in review against its original baseline, and a
  reload shows the same queue

#### Scenario: Undo a discard that deleted a new file
- **WHEN** the user discards a file the agent created, then undoes
- **THEN** the file exists again with its content and is back in review as new
