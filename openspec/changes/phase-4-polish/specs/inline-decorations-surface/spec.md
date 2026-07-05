## ADDED Requirements

### Requirement: In-file decorations review surface

The extension SHALL provide an optional review surface that highlights pending added
lines directly in the normal file editor using text decorations, as an alternative to
the native diff editor, selectable via the existing `useDiffEditor` /
`showInlineDecorations` settings.

#### Scenario: Added lines are highlighted in place
- **WHEN** inline-decorations mode is active and a file has a pending hunk with added lines
- **THEN** those lines are visually highlighted in the normal editor without opening a diff editor

#### Scenario: Switching surfaces is honored per action
- **WHEN** `useDiffEditor` is false and `showInlineDecorations` is true and the user opens a file for review
- **THEN** the file opens in the normal editor with decorations rather than the diff editor

### Requirement: Removed lines remain reviewable

The surface SHALL make removed lines reviewable via a peek/hover affordance anchored at
the hunk, since decorations cannot render removed content inline on stable APIs.

#### Scenario: Inspect removed lines
- **WHEN** a pending hunk removed lines from the baseline and the user invokes the peek affordance at that hunk
- **THEN** the removed baseline lines are shown for comparison

### Requirement: Accept/reject parity across surfaces

Per-hunk accept and reject SHALL be available and behave identically whether the active
surface is the diff editor or inline decorations.

#### Scenario: Accept a hunk in decorations mode
- **WHEN** the user accepts a decorated hunk in inline mode
- **THEN** the baseline updates and the decoration clears exactly as accepting in the diff editor would
