# Interactive Review

A VS Code extension that turns a pile of pending edits into a **queue you walk to
closure** — review each changed hunk, accept or reject it with one gesture, and reach an
explicit "review complete" state. Built for the workflow where an AI agent (or any tool)
has just changed a batch of files and you want to go through them deliberately, the way
Cursor's classic review flow feels.

It works with **any** source of changes — an AI assistant, a script, or your own edits —
because it diffs against a private baseline snapshot rather than hooking into a specific
tool. Runs on **stable VS Code APIs only** (no proposed APIs), so it installs from the
Marketplace without Insiders or `argv.json` flags.

## Status

Early development. The single-file review loop (baseline → per-hunk `Accept`/`Discard`
CodeLens in a native diff editor → baseline update) works today. The bounded-changeset
flow (turn boundary + auto-advance + review-complete state) is the next milestone. See
[`design.md`](design.md) for the architecture and phased plan.

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
