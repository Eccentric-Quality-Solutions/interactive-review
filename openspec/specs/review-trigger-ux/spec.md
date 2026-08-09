# Review Trigger UX

## Purpose

Surface the snapshot-on-command trigger as an explicit, bounded **Begin review** / **End
review** pair rather than an ambiguous persistent-sounding "Enable" / "Disable" toggle, and
guarantee the begin-review command is safe for an external agent to invoke at a turn
boundary without user interaction.

## Requirements

### Requirement: Explicit Begin review command

The extension SHALL surface the snapshot-on-command trigger as an explicit "Begin review"
command (`interactiveReview.beginReview`) that snapshots the current workspace as the
baseline and opens a bounded review session, replacing the ambiguous "Enable for this
project" label. The underlying snapshot mechanics are unchanged. The command ID SHALL match
the bounded-session framing rather than the superseded enable/disable framing, and the
superseded IDs SHALL NOT be retained as aliases.

#### Scenario: Begin review snapshots and opens a session
- **WHEN** the user runs "Interactive Review: Begin review" in a workspace with no active
  session
- **THEN** the current file contents are snapshotted as the baseline and a review session is
  opened, identically to the prior enable behavior

#### Scenario: Label communicates the bounded action
- **WHEN** the user views the command in the palette or the panel's setup screen
- **THEN** it reads as beginning a review (e.g., "Begin review"), not as enabling a
  persistent mode

### Requirement: Explicit End review command

The extension SHALL provide an "End review" command (`interactiveReview.endReview`) that
closes the current review session and tears down the baseline snapshot, replacing the
"Disable" label. Ending a review SHALL NOT modify the user's files.

#### Scenario: End review closes the session
- **WHEN** a review session is active and the user runs "End review"
- **THEN** the session closes and review state is torn down, identically to the prior
  disable behavior

#### Scenario: Ending a review leaves files untouched
- **WHEN** a review session with pending hunks is ended
- **THEN** the files on disk are left exactly as they are, and only the baseline and tracked
  review state are discarded

### Requirement: Agent-callable review trigger

The extension SHALL expose a command an external agent can invoke to begin a review at a
turn boundary, so a tool-driven edit session can open a bounded review without user
interaction, preserving the tool-agnostic property. The command SHALL be non-interactive —
no dialogs or prompts, no dependence on the review panel being visible — and its returned
promise SHALL NOT resolve until the baseline snapshot is durable.

#### Scenario: Agent opens a review at a turn boundary
- **WHEN** an agent invokes the begin-review command after completing a batch of edits
- **THEN** a bounded review session opens over the changes, walkable to closure like a
  user-initiated review

#### Scenario: The baseline is durable when the command resolves
- **WHEN** an agent awaits the begin-review command and immediately edits a file
- **THEN** that edit is diffed against the pre-edit baseline, because the snapshot completed
  before the command resolved

#### Scenario: Beginning an already-open session is safe
- **WHEN** begin-review is invoked while a session is already open
- **THEN** the call completes without error and the existing baseline is preserved
