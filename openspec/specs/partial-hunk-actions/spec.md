# Partial Hunk Actions

## Purpose

Let reviewers accept or reject a selected line range within a pending hunk rather than only
whole hunks, while keeping the review queue, counts, completion state, and undo behavior
consistent with whole-hunk actions.

## Requirements

### Requirement: Reject a selected line range within a hunk

The extension SHALL allow rejecting only the added lines within the user's current
selection that fall inside a pending hunk, reverting just those lines to baseline content
and leaving the remainder of the hunk pending.

#### Scenario: Reject part of a mixed hunk
- **WHEN** the user selects unwanted added lines inside a hunk and invokes
  `interactiveReview.rejectSelection`
- **THEN** only those lines are removed from the document (reverting to baseline) and the
  rest of the hunk stays pending

#### Scenario: Selection spanning a hunk boundary
- **WHEN** the selection extends beyond the hunk's changed lines into surrounding context
- **THEN** only the portion of the selection intersecting the hunk's added lines is
  reverted and unchanged context lines are ignored

#### Scenario: Pure-removal hunk falls back to whole-hunk reject
- **WHEN** the selection falls inside a hunk that has no added lines (a pure removal)
- **THEN** the whole hunk is rejected, restoring the removed baseline lines

#### Scenario: Selection covering no added lines
- **WHEN** the selection intersects a hunk that has added lines but the selection covers
  only context lines
- **THEN** the document is unchanged and the hunk stays pending

### Requirement: Accept a selected line range within a hunk

The extension SHALL allow accepting only the added lines within the user's current
selection that fall inside a pending hunk, folding just those lines into the baseline and
leaving the remainder of the hunk pending. Accepting never edits the document.

#### Scenario: Accept part of a mixed hunk
- **WHEN** the user selects wanted added lines inside a hunk and invokes
  `interactiveReview.acceptSelection`
- **THEN** only those lines stop being pending, the document is unchanged, and the rest of
  the hunk stays pending

#### Scenario: Selection spanning a hunk boundary
- **WHEN** the selection extends beyond the hunk's changed lines into surrounding context
- **THEN** only the portion of the selection intersecting the hunk's added lines is
  accepted

#### Scenario: Pure-removal hunk falls back to whole-hunk accept
- **WHEN** the selection falls inside a hunk that has no added lines (a pure removal)
- **THEN** the whole hunk is accepted

#### Scenario: Selection covering no added lines
- **WHEN** the selection intersects a hunk that has added lines but the selection covers
  only context lines
- **THEN** nothing is accepted and the hunk stays pending

#### Scenario: Unsaved edits refuse the accept
- **WHEN** the file has unsaved edits in an editor
- **THEN** nothing is accepted and the user is told to save first

### Requirement: Multi-hunk selections resolve a single hunk

The extension SHALL resolve a partial accept or reject against the hunk containing the
selection start, and SHALL log that any other hunks intersected by the selection were not
touched, so a spanning selection is never a silent partial success.

#### Scenario: Selection spanning two hunks
- **WHEN** the selection intersects added lines in more than one pending hunk
- **THEN** only the hunk at the selection start is resolved and the extension logs that
  the other intersected hunks were ignored

### Requirement: Partial actions preserve queue consistency

The extension SHALL recompute the remaining pending hunks and the file's reviewing status
after a partial accept or reject, so the walk, counts, and completion state stay correct.

#### Scenario: Partial action resolving the last change completes the file
- **WHEN** a partial accept or reject leaves no pending changes in the file
- **THEN** the file exits reviewing and the flow advances or completes exactly as with the
  whole-hunk action

#### Scenario: Partial reject leaving changes advances within the file
- **WHEN** a partial reject leaves one or more pending hunks in the file
- **THEN** the counts update and the cursor reveals the next remaining hunk, keeping the
  file in reviewing status

### Requirement: Partial reject is a single undo

The extension SHALL apply each partial reject as one atomic document edit so a single undo
restores the pre-action document, matching whole-hunk reject behavior.

#### Scenario: Undo after a partial reject
- **WHEN** the user rejects a selected line range and then undoes
- **THEN** the reverted lines are restored in a single undo step
