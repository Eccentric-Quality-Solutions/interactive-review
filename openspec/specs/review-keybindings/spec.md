# Review Keybindings

## Purpose

Let reviewers drive the review queue entirely from the keyboard — accept/reject a hunk,
move between hunks, accept/reject a whole file — with accept and reject as symmetric,
equally cheap, single-undo actions, so the walk never requires the mouse.

## Requirements

### Requirement: Registered review commands

The extension SHALL register command-palette commands for the core review actions —
accept hunk, reject hunk, next hunk, previous hunk, accept file, reject file — each
delegating to the existing accept/reject logic so behavior matches the CodeLens and
panel paths.

#### Scenario: Accept the current hunk from the command palette
- **WHEN** the active editor is a file with a pending hunk under the cursor and the user
  runs "Interactive Review: Accept Hunk"
- **THEN** that hunk is accepted (folded into the baseline) exactly as if accepted via
  CodeLens

#### Scenario: Commands are hidden when review is disabled
- **WHEN** review is not enabled for the workspace
- **THEN** the review action commands are not offered as enabled palette entries

### Requirement: Default keybindings for the walk

The extension SHALL contribute default keybindings for accept hunk, reject hunk, next
hunk, and previous hunk, active only when an interactive-review surface is focused, so
the queue can be walked without the mouse.

#### Scenario: Walk the queue by keyboard
- **WHEN** the user reviews a file and presses the accept-hunk keybinding
- **THEN** the current hunk is accepted and the cursor advances to the next pending hunk

#### Scenario: Keybindings do not fire outside review
- **WHEN** the focused editor is not an interactive-review surface
- **THEN** the review keybindings are inactive and the keys retain their normal behavior

### Requirement: Accept and reject symmetry

Accept and reject SHALL be equally cheap: identical affordance weight, both keyboard
bound, and each reversible with a single undo gesture.

#### Scenario: Reject is a single-gesture, single-undo action
- **WHEN** the user rejects a hunk and then issues one undo
- **THEN** the file returns to its pre-reject state in one step, symmetric with accept

### Requirement: Keyboard navigation across the queue

Next-hunk and previous-hunk commands SHALL move the review focus through pending hunks,
advancing across files when the current file's hunks are exhausted, consistent with the
existing cross-file advance.

#### Scenario: Next advances past the last hunk in a file
- **WHEN** the cursor is on the last pending hunk of a file and the user invokes next-hunk
- **THEN** the next reviewing file opens at its first pending hunk
