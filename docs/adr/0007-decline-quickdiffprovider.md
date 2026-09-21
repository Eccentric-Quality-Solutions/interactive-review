# ADR-0007 — Decline `QuickDiffProvider`

**Date:** 2026-07-12 · **Status:** Accepted

## Context

Registering a `QuickDiffProvider` — the platform machinery behind git's gutter change-bars —
would have been roughly ten lines, since we already serve baseline content through a
`TextDocumentContentProvider` (`interactive-review-baseline:`): hang a `quickDiffProvider` off
a `scm.createSourceControl(...)` whose `provideOriginalResource` returns the baseline URI.

## Decision

Declined. It buys nothing for our surface.

## Rationale

The decision turns on one fact: our red/green comes entirely from the **native diff editor**
([ADR-0003](0003-inline-diff-editor-sole-surface.md)), not from any decoration or quick-diff
machinery. QuickDiff is orthogonal to that and can neither add to nor remove from it.

- **It does not render always-on inline red/green.** It draws gutter bars plus a
  click-to-open peek of a single change. The always-on inline overlay in an *editable* buffer
  — the Copilot look — is the gated `chatEditing` **proposed** API, unreachable under
  [ADR-0001](0001-stable-apis-only.md). QuickDiff is not a stable substitute for it.
- **Its only value is in the plain file tab, which is not our review surface.** In the diff
  tab the peek is pure redundancy. QuickDiff would matter only if we supported "review while
  editing the real file," a mode we deliberately do not offer.
- **It carries a UI cost.** There is no standalone `window.registerQuickDiffProvider`; the
  only form hangs off a `SourceControl`, which adds a group to the Source Control view we do
  not want.

## Consequences

No loss — the red/green that motivated this project is already the platform's job via the diff
editor, and is fully stable. One unrelated scrap was noted and parked: the diff editor has
built-in next/previous-difference navigation (`F7` / `Shift+F7`) that overlaps
`neighbourHunk`/`revealHunk` in the diff-tab path. If that cursor-nav code is ever trimmed,
this is the lever — a minor cleanup, independent of QuickDiff.

## References

[design.md §4h](../design.md)
