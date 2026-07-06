# Changelog

All notable changes to the Interactive Review extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **In-file decorations surface (optional).** A decorations-only mode
  (`showInlineDecorations`) as an alternative to the diff editor.
- **File-level actions.** Approve or revert a whole file from the title bar, the review
  panel, or a keybinding.
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
  render inline with CodeLens while the extension is active.
- Not yet published to the Marketplace — build and install the `.vsix` locally.
