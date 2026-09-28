## ADDED Requirements

### Requirement: Bulk actions are labelled and confirmed

The panel header SHALL label its queue-wide actions **Accept All** and **Discard All**. Each
SHALL ask for confirmation in a modal that says what will happen to how many files, and
SHALL act only on the files counted when the modal opened. Dismissing the modal SHALL change
nothing. With nothing under review, neither SHALL ask.

#### Scenario: Accept All confirmed
- **WHEN** two files are under review and the user clicks Accept All and confirms
- **THEN** both files are accepted

#### Scenario: Discard All dismissed
- **WHEN** the user clicks Discard All and closes the modal
- **THEN** no file is changed

#### Scenario: A file joins the queue while the modal is open
- **WHEN** the agent edits a new file while the Accept All modal is open, and the user
  confirms
- **THEN** only the files counted when the modal opened are accepted

### Requirement: Per-row actions are always visible

Each file and hunk row in the panel SHALL show its accept (✓) and discard (↺) buttons at all
times, not only while the pointer is over the row.

#### Scenario: Row without hover
- **WHEN** the panel lists a file under review and the pointer is elsewhere
- **THEN** the row's ✓ and ↺ buttons are visible
