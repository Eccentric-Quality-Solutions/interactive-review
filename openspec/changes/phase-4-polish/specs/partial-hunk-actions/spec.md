## ADDED Requirements

### Requirement: Accept a selected line range within a hunk

The extension SHALL allow accepting only the lines within the user's current selection
that fall inside a pending hunk, folding just those lines into the baseline and leaving
the remainder of the hunk pending.

#### Scenario: Accept part of a mixed hunk
- **WHEN** a hunk contains both wanted and unwanted changes and the user selects the wanted lines and invokes accept-selection
- **THEN** only the selected lines are folded into the baseline and the unselected changes remain as a pending hunk

#### Scenario: Selection spanning a hunk boundary
- **WHEN** the selection extends beyond the hunk's changed lines
- **THEN** only the portion intersecting the hunk is applied and unchanged context lines are ignored

### Requirement: Reject a selected line range within a hunk

The extension SHALL allow rejecting only the lines within the user's current selection
that fall inside a pending hunk, reverting just those lines to the baseline and leaving
the remainder of the hunk pending.

#### Scenario: Reject part of a mixed hunk
- **WHEN** the user selects unwanted lines inside a hunk and invokes reject-selection
- **THEN** only those lines revert to baseline content and the rest of the hunk stays pending

### Requirement: Partial actions preserve queue consistency

The extension SHALL recompute the remaining pending hunks and the file's reviewing
status after a partial accept or reject, so the walk, counts, and completion state stay
correct.

#### Scenario: Partial action resolving the last change completes the file
- **WHEN** a partial action leaves no pending changes in the file
- **THEN** the file exits reviewing and the flow advances/completes exactly as with a whole-hunk action
