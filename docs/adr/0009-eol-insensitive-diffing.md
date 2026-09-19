# ADR-0009 — Diff EOL-insensitively; do not ignore other whitespace

**Date:** 2026-08-10 · **Status:** Accepted

## Context

A report that the review surface "sometimes highlights the entire file." Measurement found
the differ was *not* mis-aligning — Myers stays minimal, and scattered edits do not smear.
The whole-file signature came from tokenization.

`Diff.diffLines` splits on `\n` and compares tokens with `===`. The `\r` is **part of the
token**. Convert LF to CRLF and no token in the old sequence equals any token in the new one,
so Myers finds a zero-length common subsequence and emits one delete-all followed by one
insert-all; `computeHunks` merges consecutive changes with no context requirement, so the
whole file arrives as a **single hunk**. That is the exact user-visible signature: entire file
highlighted, *one* entry in the review queue.

Reachable here: baselines come from `git show :path` in the shadow repo (raw blob bytes) while
current text comes from `fs.readFile(..., 'utf-8')` or `doc.getText()`, and `computeHunks`
received both raw. There was no EOL normalization anywhere in `src/`.

## Decision

`computeHunks` passes `stripTrailingCr: true` to `Diff.diffLines`. A pure EOL conversion now
produces zero hunks, and an edit made in the same write as a conversion surfaces as just that
edit.

**Deliberately not paired with `ignoreWhitespace`** — a whitespace-only change is sometimes
exactly what a reviewer needs to see. The whole-file-reindent and strip-trailing-whitespace
archetypes keep costing what they cost.

## Consequences

- Two things were checked rather than assumed. **The shadow git is byte-exact regardless of
  `core.autocrlf`**: tested with `autocrlf=true`, both `git hash-object -w --stdin` (no
  `--path`, so no attributes, so no filter) and `git show :path` round-trip CRLF unchanged —
  so a Windows user does not get every file permanently showing a whole-file diff.
  **`@types/diff@5.2.3` lacks `stripTrailingCr`** though `diff@5.2.2` implements it; handled
  by module augmentation in `diffEngine.ts` rather than a cast, so the call site stays
  type-checked.
- A new dependency on VS Code behaviour became load-bearing: `discardHunk` writes
  `originalLines.join('\n')` without consulting `doc.eol`, which is safe *only because* VS
  Code normalizes `WorkspaceEdit` text to the model's EOL. Probed and confirmed in the
  extension host, and pinned by `src/test/integration/eolNormalization.test.ts` — with an
  EOL-insensitive differ, a regression there would silently rewrite the user's line endings
  without ever showing a hunk.

## Not done

If a single hunk's footprint exceeds ~80% of a file, that is now a signature of a *formatter
pass* rather than an EOL change. Surfacing that as a named condition ("whole file
reformatted") would beat presenting a 700-line hunk.

## References

[review-ui-legibility.md §7](../review-ui-legibility.md) · commit `18e80c1`.
