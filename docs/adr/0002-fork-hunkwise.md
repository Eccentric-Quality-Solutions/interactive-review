# ADR-0002 — Fork hunkwise rather than build fresh

**Date:** 2026-07-04 · **Status:** Accepted

## Context

[hunkwise](https://github.com/molon/hunkwise) (MIT, ~6.5k LOC TypeScript) already implements
the whole mechanical layer: baseline tracking in a private git repo, `diffLines` hunk
computation with position-derived ids, per-hunk apply/revert, a multi-file sidebar, and the
unglamorous edge cases — rename/delete migration, `.gitignore` sync, self-edit suppression,
non-ASCII/NFC paths, the new-vs-empty-vs-existing file distinction. It carries unit *and*
integration tests and a good `CLAUDE.md`.

Against that: version 0.0.29, ~31 commits, a single author, and dormant since April 2026.
Bus factor 1. Its architecture is also a *continuous unbounded monitor* with no notion of a
turn boundary, which is a genuine semantic mismatch with our bounded-changeset target.

Three paths were considered: fork, contribute upstream, or build fresh borrowing the
architecture.

## Decision

**Fork.** Contributing upstream was not attempted — upstream has stayed dormant.

## Consequences

- We become the maintainer of ~6.5k LOC we did not write. Assume no upstream fixes; any
  future upstream commits must be cherry-picked by hand.
- MIT attribution retained: `LICENSE` carries both molon's original and Eccentric Quality
  Solutions' modification copyright, and `README.md` credits the fork.
- The changeset/flow layer is *architectural surgery*, not addition, because the inherited
  codebase assumes an unbounded pending-set.
- Confirmed in hindsight: Phases 1 and 2 of the plan were largely **already met** by the fork,
  so the fork's value was real. The inherited buffer-vs-disk authorship heuristic, flagged
  during evaluation as a model risk, did materialize as a bug — see
  [ADR-0006](0006-save-token-provenance.md).

## References

[hunkwise-evaluation.md](../hunkwise-evaluation.md) ·
[prior-art-and-alternatives.md](../prior-art-and-alternatives.md) ·
[design.md §4a](../design.md) · commits `ec138e4` (fork), `b8b0301` (stable-only rework).
