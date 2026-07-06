# Interactive Review

A VS Code extension that turns a pile of pending edits into a **queue you walk to
closure** — review each changed hunk, accept or reject it with one gesture, and reach an
explicit "review complete" state. Built for the workflow where an AI agent (or any tool)
has just changed a batch of files and you want to go through them deliberately, the way
Cursor's classic review flow feels.

It works with **any** source of changes — an AI assistant, a script, or your own edits —
because it diffs against a private baseline snapshot rather than hooking into a specific
tool. Runs on **stable VS Code APIs only** (no proposed APIs), so it installs on stable VS
Code without Insiders or `argv.json` flags.

## Status

Early development. The single-file review loop (baseline → per-hunk `Accept`/`Discard`
CodeLens in a native diff editor → baseline update) works today, along with the
bounded-changeset flow (cross-file auto-advance and an explicit review-complete state). See
[`design.md`](design.md) for the architecture and phased plan.

## Install

Not on the Marketplace yet — build and install the `.vsix` locally:

```sh
npm install
npm run compile
npx @vscode/vsce package
code --install-extension vsc-interactive-review-*.vsix
```

Then **reload VS Code** (Command Palette → *Developer: Reload Window*). Installed VSIXs
don't hot-reload, so re-run the package + install + reload steps after pulling changes.

## Using it

1. **Enable** — Command Palette → *Interactive Review: Enable*. This snapshots a private
   baseline of your working tree; every later change is diffed against it, no matter what
   made the change.
2. **Make edits** — let an AI agent, a script, or you change files.
3. **Walk the queue** — the **Interactive Review** panel (bottom panel, alongside Terminal
   and Problems) lists every changed file. Click a file or hunk to open it.

### Review surface

By default, clicking a file or hunk opens a **single-column inline diff** — removed
baseline lines in red, new lines in green — with `Accept` / `Discard` CodeLens buttons on
each hunk. Keyboard shortcuts, while a review editor is focused:

| Key | Action |
| --- | --- |
| `Alt+A` | Accept hunk |
| `Alt+R` | Reject hunk |
| `Alt+Shift+A` | Accept selected lines |
| `Alt+Shift+R` | Reject selected lines |
| `Alt+N` / `Alt+P` | Next / previous hunk |

Accepting folds the change into the baseline; rejecting restores the baseline text. The
selection actions work on messy hunks where you want only *some* of the added lines: accept
folds the selected added lines into the baseline (the rest stay pending), reject deletes
them. When the last hunk across all files is resolved, the panel shows **review complete**.

> **Heads-up:** while enabled on the diff-editor surface, the extension sets the *global* VS
> Code settings `diffEditor.renderSideBySide = false` and `diffEditor.codeLens = true` so
> review diffs render inline with visible Accept/Discard buttons. VS Code has no per-diff
> override for these, so the change also affects your **other** (git, manual) diffs. Flip
> them back in Settings if you prefer side-by-side.

### Settings

Open the panel's **gear** icon. Notable option:

- **Open diff editor from panel** (default *on*) — the inline-diff surface above. Turn it
  *off* to review with in-editor decorations instead: added lines are highlighted in place,
  and removed lines are reachable via a *"Show N removed lines"* peek (stable VS Code APIs
  can't render deleted lines inline in a normal editor).

Settings persist in `.vscode/interactive-review/` **per workspace**, not in your VS Code
`settings.json`. One consequence: changing a default in code only affects workspaces
enabled *afterward* — an already-enabled workspace keeps its saved values until you toggle
them in the panel.

## Development

```sh
npm run compile          # or: npm run watch
npm test                 # unit tests (fast, mocked vscode)
npm run test:integration # full VS Code integration suite
```

Integration tests run in a dedicated scratch workspace at
[`src/test/integration/workspace/`](src/test/integration/workspace/) and write transient
fixture files there. That folder's contents are **gitignored** (except `.gitkeep`) so they
stay out of git *and* don't flash through the review panel of a live extension watching
this repo while the suite runs. The test instance is rooted at that folder and only reads
`.gitignore` files at or below it, so the repo-root ignore rule never hides fixtures from
the tests themselves.

## Credits & attribution

**Interactive Review is a fork of [hunkwise](https://github.com/molon/hunkwise) by
[molon](https://github.com/molon)** (MIT-licensed). It is *not* original-from-scratch work:
the baseline tracking, hunk computation, native-diff-editor rendering, multi-file sidebar,
and the extensive edge-case handling (rename/delete, `.gitignore`, non-ASCII paths) all come
from hunkwise, along with its unit and integration test suites. Full credit to molon for
that foundation.

What this fork changes:

- **Removed the proposed `editorInsets` API** (and its sole consumer) so the extension is
  Marketplace-shippable on stable VS Code.
- **Rebranded** to Interactive Review (`eccentricqualitysolutions.vsc-interactive-review`)
  and renamed the command / view / URI-scheme / state-directory ids — and the internal
  identifiers — accordingly (e.g. hunkwise's `HunkwiseGit` baseline-git module is now
  `BaselineGit`).
- **In progress:** a bounded *changeset* state machine (turn boundary + auto-advance +
  review-complete) — the piece hunkwise's continuous, unbounded monitor does not have.

Both the original work and these modifications are under the MIT License — see
[`LICENSE`](LICENSE), which retains molon's copyright notice as required.

## License

[MIT](LICENSE) — Copyright (c) 2025 molon (original), Copyright (c) 2026 Eccentric Quality
Solutions (modifications).
