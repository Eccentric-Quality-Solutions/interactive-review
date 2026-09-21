# ADR-0010 — Withdraw gated hunk coalescing

**Date:** 2026-08-10 · **Status:** Accepted (feature withdrawn, never implemented)

## Context

A single logical prose edit produced **six** hunks, because `computeHunks` runs `diffLines` at
zero context: a hunk is a maximal run of changed lines bounded by *any* unchanged line, and
one blank line is enough to end one. The region paints as one continuous block, so the first
Accept silently takes only three lines.

The proposed fix was to coalesce hunks separated by short runs of trivial content:

> Coalesce iff the gap is <= 3 lines **AND** every interior line matches `/^\s*$/` or
> `/^\s*([-*_=])\1{2,}\s*$/`.

## Decision

**Withdrawn.** Not implemented and not planned.

## Rationale

- Whole-file Accept from the panel row **already** collapses a fragmented prose edit to one
  click. Coalescing bought a cosmetic win over a shipped workaround.
- The cost was not small: a `computeHunks` rewrite, plus a *mandatory* companion fix in the
  same commit to `splitHunkByRange` / `acceptSelection` / `rejectSelection`. Those selection
  paths break under coalescing — `rejectSelection` would delete interior *unchanged* lines,
  and `acceptSelection` inserts past the entire merged old region, writing interior context
  into the baseline twice. That is baseline corruption, not a display wart.
- **The gate on code files was never settled, and that was itself part of the reason.** Roughly
  half of single-line gaps in `.ts` files here are blank lines, so two edits separated by one
  blank line inside a function would merge. For prose that is obviously right; for code it is
  arguable, and there is a standing complaint pointing the *other* way ("sometimes it is
  grabbing bigger chunks of code").
- **Multi-hunk selection reaches the same goal** — one gesture per logical edit — without
  touching the differ. It is fixable at the command layer (~30–40 lines) by iterating every
  intersecting hunk. With coalescing withdrawn, that is *the* route to that goal, tracked as
  backlog item **C**.

## Consequences

- The differ stays correct and untouched; the legibility problem is addressed instead by
  cheaper, non-semantic means (re-anchoring the CodeLens to the hunk's first line and putting
  the extent in its title — backlog item **B**).
- Fragmentation remains visible on prose edits.

## Revisit if

Item **C** ships and fragmentation still bites. If reopened, **answer the code-gate question
first** — it is the blocker, not the implementation.

## References

[review-ui-legibility.md §1–§5](../review-ui-legibility.md) · [`../../todo.md`](../../todo.md).
