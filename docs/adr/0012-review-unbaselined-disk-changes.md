# ADR-0012 — A disk change with no baseline is reviewed, unless a snapshot window is open

**Date:** 2026-08-17 · **Status:** Accepted (consequences amended 2026-09-02) · **Supersedes** [ADR-0008](0008-null-baseline-silent-absorb.md)

## Context

[ADR-0008](0008-null-baseline-silent-absorb.md) left `handleDiskChange`'s no-baseline branch
absorbing the edit — adopting current disk content as the baseline, producing no hunk. It was
accepted as a **known gap** ("Cause B"), the sole remaining path by which a genuine agent edit
can vanish, on the grounds that flipping it risked spurious "new file" hunks *"during exactly
those transient states"* — enable in flight, ignore-rule sync in flight.

That reasoning has expired. When ADR-0008 was written, "is a snapshot in flight?" was not a
question the code could answer, so the absorb was the only way to stay quiet during one. Since
then the enable window became an explicit, synchronously-sampled flag
(`SnapshotCreateTracker`, `ccb994d`) precisely so `handleDiskCreate` could tell "not yet
baselined" from "new". `handleDiskChange` was never given the same distinction and kept
conflating the two.

The conflation is not symmetric in cost. Being wrong toward *review* costs one dismissable
whole-file hunk. Being wrong toward *absorb* silently discards an agent's edit — the one
outcome a tool whose entire promise is "review pending edits" must not produce. ADR-0008 said
as much and accepted it anyway, because at the time the alternative was unconditional.

## Decision

Invert the default. A disk change to a file with no baseline is **reviewed as a new file**
(`enterReviewing(filePath, null, diskContent)`), *unless* a window is open in which a missing
baseline is expected:

- `FileWatcher.snapshotCreates.active` — the enable snapshot, sampled at handler entry, for
  the same reason `handleDiskCreate` samples it there: arrival time is the property being
  tested, and this handler awaits a disk read and a git read before reaching the branch.
- `StateManager.ignoreSyncActive` — a `syncIgnoreState` pass, whose `toAdd` path legitimately
  leaves newly un-ignored files unbaselined until its git queue drains. A depth counter, not a
  boolean: the sync fires from three independent triggers and two passes can overlap, and the
  first to finish must not reopen the gap while the second is still adding baselines.

Both windows are **named flags, not inferred conditions**, so the fallthrough direction is the
safe one: a state nobody anticipated reviews rather than drops.

## Consequences

- **Cause B is closed.** A missed external CREATE that surfaces only as a CHANGE now reaches
  the queue. The `KNOWN GAP` comment and the emphatic log line are gone; the branch logs which
  window it matched, or that it found none and is reviewing.
- **The failure mode of a leaked enable window inverts.** `settleSnapshotCreates` exists
  because a `beginReview` that resolves early leaves real baselines unwritten. That used to
  present as a silently swallowed edit; it now presents as a spurious whole-file "new file"
  hunk. Strictly better — loud beats silent — but the guard is still load-bearing, and its
  doc comment now says so.
- **Files unreadable at enable now surface on their next edit**, as a whole-file add rather
  than nothing. Correct, and arguably the first time the user learns the file was skipped.
- **Binary exception (2026-09-02).** Enable deliberately skips binaries, so a pre-existing
  asset has no baseline. The fallthrough above would mislabel a rewrite of that asset as a
  *new* file, and Discard would trash it. `handleDiskChange` therefore returns without
  reviewing when the no-baseline change is binary. `handleDiskCreate` is unchanged — a
  genuinely new binary still enters the queue.
- **Amended (2026-09-19): "new" is now recorded, not inferred.** The exception above fixed
  one population of a larger fault. `baseline: null` was carrying two meanings — "did not
  exist before" and "we never got a baseline" — and Discard read it as the first, so it
  deleted files it had not created. Binaries were the loudest instance; files unreadable at
  enable, and everything `adoptUntrackedFiles` picked up on a Refresh, were the quiet ones.
  `FileState.nullReason` now carries the distinction explicitly: only a witnessed create
  says `'created'`, and only `'created'` licenses the delete. This branch therefore enters
  a no-baseline change as `'unbaselined'` — reviewed, per the decision above, but never
  deleted. The binary skip survives as a display decision rather than a safety one. Pinned
  by `preexistingFiles.test.ts`.
- `syncIgnoreState`'s own silent `toAdd` snapshot is untouched. It runs *inside* the window
  this ADR defines, so it stays consistent with the branch rather than contradicting it.
- The ADR-0008 characterization test flipped from `notStrictEqual` to `strictEqual`, exactly
  as its "flip this assertion" note anticipated, and gained a companion asserting the absorb
  still holds inside the window — the half a bare flip would have silently regressed.

## Not done

- **No test drives the real timing race**, only the flag. Reproducing it needs a snapshot slow
  enough to fire a change inside, which tests the host's scheduling rather than this
  behaviour.
- **Not verified on an installed build.** Unit- and integration-verified only.

## References

`src/fileWatcher.ts` (`handleDiskChange`) · `src/stateManager.ts` (`ignoreSyncActive`) ·
`src/test/integration/saveVsExternalEdit.test.ts` ·
[terminal-edits-not-captured.md §5](../terminal-edits-not-captured.md) — the original
diagnosis.
