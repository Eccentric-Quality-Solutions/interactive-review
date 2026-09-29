## ADDED Requirements

### Requirement: Load and Refresh queue every changed file whatever the workspace size

The extension SHALL read baselines, file contents and binary checks during load, Refresh,
Begin review and an ignore-rule sync with a bounded number of concurrent operations, so that
the number of files in the workspace cannot exhaust the process's file descriptors. A file
whose content differs from its baseline SHALL be in the review queue after load or Refresh.

#### Scenario: Large workspace under a low descriptor limit
- **WHEN** a workspace has 500 baselined files, every one edited on disk, and the extension
  host runs with a file-descriptor limit of 256
- **THEN** after Refresh all 500 files are in the review queue

#### Scenario: Concurrency stays bounded
- **WHEN** load or Refresh reads baselines for more files than the concurrency limit
- **THEN** no more than the limit of those reads are in flight at once

### Requirement: Panel hunk actions act whether or not the file is open

The extension SHALL carry out a per-hunk Accept from the review panel when the file has no
open document, by opening the document first, exactly as the per-hunk Discard does.

#### Scenario: Accept a hunk of a file whose tab was closed
- **WHEN** the user expands a file in the panel, closes its diff tab, and clicks Accept on
  one of two hunks
- **THEN** that hunk is accepted, the other stays pending, and the file stays in review

#### Scenario: Unsaved edits still refuse the accept
- **WHEN** the file is open with unsaved edits and the user clicks a hunk's Accept
- **THEN** nothing is accepted and the user is told to save first, as today

### Requirement: A file leaves review only when disk matches its baseline

The extension SHALL NOT take a file out of review because its unsaved editor buffer matches
the baseline. The file SHALL leave review when that content is saved to disk. A buffer that
is discarded without saving SHALL leave the file in review with its pending changes.

#### Scenario: Typing back to baseline without saving
- **WHEN** a reviewing file's buffer is edited until it equals the baseline, and not saved
- **THEN** the file is still in the review queue

#### Scenario: Saving the buffer that matches the baseline
- **WHEN** that buffer is then saved
- **THEN** the file leaves review

#### Scenario: Reload after an unsaved revert
- **WHEN** the buffer is closed without saving and the window reloads
- **THEN** the file is in the review queue with the same pending changes it had before the
  buffer was edited

Existing requirements this touches, none of which change: `review-keybindings` "Accept and
reject symmetry" and `partial-hunk-actions` "Partial actions preserve queue consistency"
(both save their edits, so their files still leave review at once), and `panel-undo` "Every
accept and discard is one undoable action" (an accept that now awaits the document is still
one entry).
