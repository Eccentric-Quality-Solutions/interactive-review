## Why

Real diffs are messy: a single hunk often mixes a change the reviewer wants with one they
don't. Today the walk resolves at whole-hunk (or whole-file) granularity only, so a
reviewer who wants to drop just the bad lines must reject the whole hunk and re-apply the
good part by hand. When reviewing AI-authored edits, "kill these specific lines, keep the
rest" is the common gesture — so the highest-value next step in the "Cursor-classic" flow
is **sub-hunk reject** over a line selection.

Partial *accept* is deliberately deferred: it requires reconstructing the baseline and
re-deriving the pending set through a greedy line diff, which can silently mis-align the
accepted line. That risk deserves its own change with dedicated coverage, not a symmetric
ride-along. See Non-Goals.

## What Changes

- Add **line-range reject**: revert only the added lines inside the user's editor
  selection that intersect a pending hunk, leaving the rest of the hunk pending.
- Add new range-splitting logic in `diffEngine` that, given a hunk and a selection line
  range, computes the intersecting **added** line indices.
- Register `interactiveReview.rejectSelection` with a default keybinding, gated by the
  existing `interactiveReview.inReview` context key from Group 1.
- Recompute hunks and the file's reviewing status after a partial reject so the walk,
  counts, and completion (`exitReviewing`) stay correct — including when the partial
  action resolves the file's last remaining change.
- **Fallbacks/signals:** a pure-removal hunk (no added lines) falls back to whole-hunk
  reject; a selection that intersects more than one hunk resolves the hunk at the
  selection start and logs that the others were ignored.

## Capabilities

### New Capabilities
- `partial-hunk-actions`: reject only the added lines within the current selection that
  fall inside a pending hunk, keeping the queue, counts, and completion consistent.

### Modified Capabilities
<!-- None: no main specs have been synced yet; this introduces a new capability. -->

## Impact

- **Code:** `src/diffEngine.ts` (new range-split helper), `src/commands.ts`
  (`rejectSelection`, mirroring `discardHunk`), `src/extension.ts` (command registration),
  `package.json` (command + keybinding).
- **Reused, unchanged:** `computeHunks` / `hunkId`, `discardHunk` (whole-hunk fallback),
  the `remainingHunks === 0 → exitReviewing` branch, `revealNextHunk`, and the
  `interactiveReview.inReview` gating.
- **No change** to baseline/git storage, the reviewing-set state model, or the trigger UX.
- **Carve-out** of Group 2 from the `phase-4-polish` umbrella, reduced to partial reject;
  partial accept is deferred to a follow-up change.
