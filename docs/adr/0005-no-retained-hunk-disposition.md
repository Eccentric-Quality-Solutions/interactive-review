# ADR-0005 — No typed changeset model, no retained per-hunk disposition

**Date:** 2026-07-05 · **Status:** Accepted

## Context

The design sketched a typed aggregate:

```
Changeset { id, trigger, files: FileEntry[], status }
FileEntry { path, hunks: Hunk[] }
Hunk      { id, range, disposition: 'pending' | 'accepted' | 'rejected' }
```

By the time the flow layer was built, [ADR-0004](0004-snapshot-on-command-trigger.md) had
already bounded the reviewing set at snapshot time, and resolution had settled as
*destructive*: accept folds the content forward into the baseline, reject reverts the buffer.
Either way the hunk stops differing from the baseline and simply ceases to exist.

## Decision

Do not build the typed model, and do not retain per-hunk disposition. "Pending" means
*still differs from the baseline*; completion is a **boolean**, not an aggregate.

## Consequences

- `StateManager.reviewComplete` is latched at the mutation source — the session saw at least
  one pending file and drained to zero — so it holds for every caller, and is distinct from
  idle. Surfaced as a status-bar item and a panel badge.
- Cross-file advance works without a changeset object: resolving a file's last hunk opens the
  next reviewing file at its first hunk.
- Features that genuinely need retained disposition — summary statistics, un-accept — are
  **not available** and would require reimplementing the resolution engine. That is the price,
  and it is the trigger for revisiting: commit to such a feature first, then reopen this.

## References

[design.md §4d](../design.md) · [interactive-review-model.md §7](../interactive-review-model.md)
· commits `be8f227` (review-complete), `068d741` (cross-file advance).
