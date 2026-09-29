# Changelog

All notable changes to the Interactive Review extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-27

Not published to the Marketplace; build and install the `.vsix` locally.

### Added

- **Undo in the review panel.** Every accept and discard, at hunk, selection, file or queue
  level, is one entry in the session's history. The panel's Undo button offers the last
  action, back through the last Accept All or Discard All, or everything. A file changed
  since the action is left as it is on disk and goes back into review.
- **Confirmation for Accept All and Discard All.** Discard All says how many files it will
  revert, delete, or leave as they are before it runs.
- **File count on the panel tab**, the way Problems and Ports show theirs.

### Fixed

- Discard deletes a file only when the session saw it being created. A file that existed
  before the review, but had no saved original, is left on disk.
- Binary files are never stored as a baseline, so a discard cannot write a lossy text copy
  over one.
- Line-ending-only and byte-order-mark-only differences no longer show as changes, and a
  file's byte order mark survives accept and restore.
- Review decisions survive a Refresh, a window reload and a rename.
- Deleting a folder queues every file it held, including ones never edited. Files written
  into a newly created folder are no longer missed.
- Accepting a hunk while the file has unsaved edits is refused with a message.
- A failed Begin review closes the half-open session so it can be retried.

## [0.0.1] — Unreleased

Initial development release. Forked from [molon/hunkwise](https://github.com/molon/hunkwise)
and reworked to run on **stable VS Code APIs only** (no proposed APIs).

### Added

- **Walk-a-queue review flow.** Turn a batch of pending edits into a queue you walk to
  closure: review each changed hunk, accept or reject it, and reach an explicit **review
  complete** state when the last hunk across all files is resolved.
- **Baseline snapshot model.** Changes are diffed against a private per-workspace git
  baseline (`.vscode/interactive-review`) rather than hooking a specific tool, so the queue
  works with any source of edits — an AI agent, a script, or your own saves.
- **Inline diff review surface (default).** The native diff editor, forced to unified/inline
  rendering, shows removed (red) and added (green) lines in place with per-hunk
  `Accept`/`Discard` CodeLens.
- **Build identity.** The panel's splash and settings screens, and the log on activation,
  show the version, commit and build time, marked `-dirty` for a build of uncommitted
  source, so it is clear which build is installed.
- **File-level actions.** Approve or revert a whole file from the editor title bar, the
  review panel, or the command palette.
- **Cross-file auto-advance.** Resolving a file's last hunk opens the next reviewing file at
  its first hunk, so the whole changeset walks as one queue.
- **Keyboard-driven review** (while a review editor is focused):
  - `Alt+A` — accept hunk · `Alt+R` — reject hunk
  - `Alt+Shift+A` — accept selected lines · `Alt+Shift+R` — reject selected lines
  - `Alt+N` / `Alt+P` — next / previous hunk
- **Partial-hunk actions.** On a messy hunk, accept or reject only the added lines inside a
  line selection, leaving the rest pending. Accept folds the selected lines into the
  baseline; reject deletes them.
- **User-edit vs. external-edit discrimination.** Edits you make and save by hand are
  adopted into the baseline silently; changes written to disk out-of-band (an agent, a
  script, a formatter) are surfaced for review.

### Known issues

- Enabling the inline diff surface nudges the **global** `diffEditor.renderSideBySide` and
  `diffEditor.codeLens` settings (VS Code exposes no per-diff override), so your other diffs
  render inline with CodeLens during a review session. They are restored when you end it.
- Not yet published to the Marketplace — build and install the `.vsix` locally.
