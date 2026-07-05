## ADDED Requirements

### Requirement: Explicit Begin review command

The extension SHALL surface the snapshot-on-command trigger as an explicit "Begin
review" command that snapshots the current workspace as the baseline and opens a bounded
review session, replacing the ambiguous "Enable for this project" label. The underlying
snapshot mechanics are unchanged.

#### Scenario: Begin review snapshots and opens a session
- **WHEN** the user runs "Interactive Review: Begin review" in a workspace with no active session
- **THEN** the current file contents are snapshotted as the baseline and a review session is opened, identically to the prior enable behavior

#### Scenario: Label communicates the bounded action
- **WHEN** the user views the command in the palette or the panel's setup screen
- **THEN** it reads as beginning a review (e.g., "Begin review"), not as enabling a persistent mode

### Requirement: Explicit End review command

The extension SHALL provide an "End review" command that closes the current review
session and tears down the baseline snapshot, replacing the "Disable" label.

#### Scenario: End review closes the session
- **WHEN** a review session is active and the user runs "End review"
- **THEN** the session closes and review state is torn down, identically to the prior disable behavior

### Requirement: Agent-callable review trigger

The extension SHALL expose a command an external agent can invoke to begin a review at a
turn boundary, so a tool-driven edit session can open a bounded review without user
interaction, preserving the tool-agnostic property.

#### Scenario: Agent opens a review at a turn boundary
- **WHEN** an agent invokes the begin-review command after completing a batch of edits
- **THEN** a bounded review session opens over the changes, walkable to closure like a user-initiated review
