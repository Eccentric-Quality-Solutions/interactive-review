# ADR-0003 — The native inline diff editor is the sole review surface

**Date:** 2026-07-05 (decorations surface removed 2026-07-12; consequences corrected
2026-08-10) · **Status:** Accepted

> **Amendment 2026-08-10.** The nudge was described as lasting "while the extension is
> enabled". False — nothing restored it, so installing rewrote two user preferences
> permanently. Decision unchanged; the write is now borrowed and given back.

## Context

The fork shipped two review surfaces: in-file decorations, and the native diff editor with
CodeLens. Settled by dogfooding on this repo with real multi-file agent edits.

A decorations-only surface **cannot show removed lines inline** on stable APIs
([ADR-0001](0001-stable-apis-only.md)). It highlights added lines in place and hides removed
content behind a *"Show N removed lines"* peek. For a tool whose pitch is *reviewing* each
change deliberately, seeing what a modification replaced is table stakes, not a peek away.

Two attempts to get diff-editor visuals with an in-file feel were rejected:

- *Inject commented-out old lines into the real buffer, styled red.* Breaks the core
  invariant `hunks = diff(baseline, currentBufferText)` — the injected lines become part of
  `currentBufferText`, so the diff eats its own tail, and they can be saved to disk. There is
  also no universal comment syntax (Markdown, JSON, plaintext have none).
- *A custom read-only virtual document rendering an inline diff.* Reinvents syntax
  highlighting, word-level diff, and hunk navigation that the diff editor already provides.

## Decision

The native diff editor, **forced to inline/unified rendering**, is the review surface. The
optional decorations surface, its `useDiffEditor` / `showInlineDecorations` settings, the
`InlineDecorations` module, and the removed-lines peek were deleted outright on 2026-07-12 —
there is no toggle.

## Consequences

- Inline rendering requires `diffEditor.renderSideBySide = false` and
  `diffEditor.codeLens = true`, and VS Code exposes no per-diff override — so the extension
  writes the user's **global** settings. The write is **borrowed, not taken**:
  [`diffSettings.ts`](../../src/diffSettings.ts) ledgers the prior values and restores them
  when the session ends. Mechanism and its two non-obvious invariants are documented there;
  [design.md §4e](../design.md) has the narrative.
- While a session is open, the user's *other* (git, manual) diffs also render inline. A
  README heads-up; the cost of "always inline" on stable APIs.
- Two residual gaps, stated not solved: closing VS Code or uninstalling *mid-session* leaves
  the settings forced (no uninstall hook), and settings carry no provenance, so a user who
  sets a key to the value we force has it removed on restore.
- The modified side being a real `TextEditor` is what the entire action layer rests on:
  CodeLens exists only on text documents, and selection-driven partial accept is defined in
  terms of `editor.selection`. Owning a custom render surface would forfeit both.
- It exposed a latent same-`fsPath`/different-scheme bug and produced a standing invariant —
  see [design.md §4e](../design.md).

## Revisit if

Reports keep arriving where paint and lens disagree with *heterogeneous* causes;
`TextEditorDiffInformation` ships stable; a roadmap item independently requires owning the
surface; or the stable-only charter is relaxed for an Insiders build.

## References

[design.md §4e](../design.md) · [review-ui-legibility.md §5 "Not now"](../review-ui-legibility.md)
