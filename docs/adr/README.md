# Architecture Decision Records

One file per settled decision: what was decided, the fact that forced it, and what it costs.
These are the **authoritative record of the verdict**. The narrative docs
([design.md](../design.md), [review-ui-legibility.md](../review-ui-legibility.md),
[terminal-edits-not-captured.md](../terminal-edits-not-captured.md)) keep the *investigation* —
the reproductions, the measurements, the bugs found along the way — and link here for the
decision itself.

An ADR is immutable once accepted. To change a decision, write a new ADR that supersedes it
and mark the old one **Superseded by ADR-NNNN**. Where a later ADR narrows one consequence
of an otherwise-standing decision, mark the old one **Amended by ADR-NNNN** instead and say
in one line what moved — the decision survives, so superseding it would overstate the change.

| # | Decision | Date | Status |
|---|---|---|---|
| [0001](0001-stable-apis-only.md) | Stable VS Code APIs only — no `editorInsets` | 2026-07-04 | Accepted |
| [0002](0002-fork-hunkwise.md) | Fork hunkwise rather than build fresh | 2026-07-04 | Accepted |
| [0003](0003-inline-diff-editor-sole-surface.md) | The native inline diff editor is the sole review surface | 2026-07-05 | Accepted (consequences amended 2026-08-10) |
| [0004](0004-snapshot-on-command-trigger.md) | Snapshot-on-command is the trigger; the watcher is secondary | 2026-07-05 | Accepted |
| [0005](0005-no-retained-hunk-disposition.md) | No typed changeset model, no retained per-hunk disposition | 2026-07-05 | Accepted |
| [0006](0006-save-token-provenance.md) | Discriminate user saves from external writes by save-event provenance | 2026-07-12 | Accepted |
| [0007](0007-decline-quickdiffprovider.md) | Decline `QuickDiffProvider` | 2026-07-12 | Accepted |
| [0008](0008-null-baseline-silent-absorb.md) | A disk change with no baseline is absorbed, not reviewed | 2026-07-12 | Superseded by [0012](0012-review-unbaselined-disk-changes.md) |
| [0009](0009-eol-insensitive-diffing.md) | Diff EOL-insensitively; do not ignore other whitespace | 2026-08-10 | Accepted |
| [0010](0010-withdraw-gated-hunk-coalescing.md) | Withdraw gated hunk coalescing | 2026-08-10 | Accepted |
| [0011](0011-baseline-invalidation-owned-by-state.md) | Baseline invalidation is owned by state, not by commands | 2026-08-11 | Accepted |
| [0012](0012-review-unbaselined-disk-changes.md) | A disk change with no baseline is reviewed, unless a snapshot window is open | 2026-08-17 | Accepted (consequences amended 2026-09-02) |
| [0013](0013-bom-insensitive-comparison.md) | Compare BOM-insensitively; store the BOM untouched | 2026-08-17 | Accepted |
