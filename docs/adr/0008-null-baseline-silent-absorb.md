# ADR-0008 — A disk change to a file with no baseline is absorbed, not reviewed

**Date:** 2026-07-12 · **Status:** **Superseded by [ADR-0012](0012-review-unbaselined-disk-changes.md)** (2026-08-17)

## Context

In `handleDiskChange`, after provenance has ruled out a user save
([ADR-0006](0006-save-token-provenance.md)):

```ts
const gitBaseline = await git.getBaseline(filePath);
if (gitBaseline === undefined) {
  this.stateManager.snapshotFile(filePath, diskContent);   // silently adopt — NO hunk
  return;
}
this.enterReviewing(filePath, gitBaseline, diskContent);   // review it
```

`snapshotWorkspace` baselines every non-ignored readable file at enable time, so a normal file
that existed at enable *has* a baseline. The `undefined` branch fires only for files that were
unreadable at enable, or that were untracked at enable and are now being modified — and for
transient states while enable or an ignore-rule change is in flight.

Flipping it to `enterReviewing(filePath, null, diskContent)` would recover those edits, at the
risk of spurious "new file" hunks during exactly those transient states. This is the sole
remaining path by which a genuine agent edit can go missing (known as **Cause B**).

## Decision

Leave the absorb in place, but make it **loud and pinned**:

- `handleDiskChange` logs at entry and on every branch, with an emphatic line on this path, so
  a future miss is findable in the "Interactive Review" output channel rather than invisible.
- The code carries a `KNOWN GAP (Cause B)` comment pointing at the diagnosis.
- A **characterization** test pins the current silent-absorb behaviour, with a "flip this
  assertion" note for whoever changes the decision.

## Consequences

- A silently-dropped edit remains possible in a narrow case. For a tool whose whole promise is
  "review pending edits," this is its worst failure mode, which is why it is logged rather
  than merely tolerated.
- The decision is explicitly one to *make*, not to drift into. The characterization test means
  changing it is a one-line, one-test edit rather than an archaeology exercise.
- Adjacent guard, not a fix for this: a file created *while* `snapshotWorkspace` runs is
  adopted as a baseline rather than classified as new (`ccb994d`,
  `src/snapshotCreateTracker.ts`).

## References

[terminal-edits-not-captured.md §5, §8, §9](../terminal-edits-not-captured.md) ·
`src/fileWatcher.ts` · `src/test/integration/saveVsExternalEdit.test.ts`.
