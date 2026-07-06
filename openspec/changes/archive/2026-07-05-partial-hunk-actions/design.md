## Context

This is Group 2 of the `phase-4-polish` umbrella, carved into its own change and reduced
to **partial reject** (partial accept is deferred — see Non-Goals). Group 1 landed the
keyboard walk: cursor-resolved `acceptHunk` / `rejectHunk` / `nextHunk` / `prevHunk`
commands, the `interactiveReview.inReview` context key, and default keybindings gated on
it.

The resolution mechanics live in `src/commands.ts`:
- `discardHunk` reverts a whole hunk in the **document** — a `WorkspaceEdit` replaces the
  document's new-region with the baseline's old lines, saves, then recomputes hunks and
  runs the tail: if `remainingHunks.length === 0` call `stateManager.exitReviewing(...)`
  (incl. the new-file `unlink` case), else `revealNextHunk(...)`.
- `acceptHunk` folds a hunk into the **baseline** (document untouched).

Hunks are positional (`ParsedHunk` + `hunkId`) and recomputed live via
`computeHunks(baseline, current)` — there is no persistent per-line disposition model, and
resolution is destructive.

The gap: reject acts at whole-hunk granularity only. This change adds sub-hunk reject over
an editor line selection.

## Goals / Non-Goals

**Goals:**
- Reject only the **added lines inside the editor selection** that intersect a pending
  hunk, leaving the rest pending.
- Confine the new "which lines are in range" math to `src/diffEngine.ts` (pure, testable,
  no VS Code types), so `commands.ts` stays a thin wrapper mirroring `discardHunk`.
- Reuse the existing recompute/advance/`exitReviewing` tail and the whole-hunk
  `discardHunk` (as the pure-removal fallback) unchanged.

**Non-Goals:**
- **Partial accept — deferred to a follow-up change.** Accepting a sub-range means
  rebuilding the baseline and re-deriving the pending set through a greedy line diff, which
  can silently mis-align the accepted line (accept with no visible effect). That risk needs
  its own change with a post-accept assertion that the accepted lines actually left the
  pending set. Not worth coupling to the low-risk reject path.
- No per-line disposition model or `Changeset`/`FileEntry` types (deferred).
- No sub-line (intra-line) selection — line granularity only.
- No partial reject of individual **removed** lines inside a mixed hunk (ambiguous under a
  line diff); pure-removal hunks fall back to whole-hunk reject.
- No change to baseline/git storage, the reviewing-set model, or keybinding gating.

## Decisions

### 1. A pure range-split helper in `diffEngine`

Add a pure function that intersects a selection with a hunk's added-line span:

```ts
export interface HunkRangeSplit {
  hasAddedInRange: boolean;
  addedStartIdx: number; // inclusive index into hunk.addedContent
  addedEndIdx: number;   // exclusive
}
// selStartLine/selEndLine are 0-based document line numbers (editor selection).
export function splitHunkByRange(
  hunk: ParsedHunk, selStartLine: number, selEndLine: number
): HunkRangeSplit
```

The hunk's added lines occupy 0-based document lines
`[hunk.newStart - 1 .. hunk.newStart - 1 + hunk.newLines - 1]`. Intersecting that span
with `[selStartLine, selEndLine]` yields a **contiguous** added-index slice `[a, b)` (a
line selection is always contiguous). `hasAddedInRange` is false when `newLines === 0` or
the intersection is empty. *Alternative rejected:* passing VS Code `Selection` objects into
`diffEngine` — keeps the module VS-Code-free and unit-testable in isolation.

### 2. Partial reject deletes the selected added lines from the document

`rejectSelection` mirrors `discardHunk`. Reverting an *added* line means deleting it (it
was not in the baseline). Build a single `WorkspaceEdit` deleting document lines
`[newStart-1 + a .. newStart-1 + b)`, mark the self-edit, save, then recompute against the
**unchanged** baseline. Removed lines in a mixed hunk are left pending.

This is deterministic: because the baseline never changes, there is no diff realignment to
reason about — the remaining pending set is exactly the hunk minus the deleted lines.
*Alternative rejected:* replacing the slice with baseline lines as `discardHunk` does for a
whole hunk — a partial reject of additions has no corresponding baseline lines to insert; a
plain delete is the correct inverse.

### 3. Fallbacks and signals, not silent no-ops

- **Pure-removal hunk** (`hasAddedInRange === false` because `newLines === 0`): delegate to
  the existing `discardHunk` for the whole hunk. One code path, tested behavior.
- **Selection covers no added lines** in an add-bearing hunk: no-op, and `log()` that
  there was nothing to reject in range (so it isn't a mysterious dead key).
- **Selection spans more than one hunk:** resolve the hunk at the selection start only and
  `log()` that other intersected hunks were ignored. Never a silent partial success.

*Alternative rejected:* resolving every intersected hunk in one gesture — multi-hunk
resolution is deferred; a spanning selection is rare and the single-hunk + log behavior is
predictable.

### 4. Reuse the recompute/advance tail verbatim

After the edit, run the exact existing `discardHunk` tail: recompute hunks; if none remain,
`exitReviewing` (including the new-file `unlink` case); else `revealNextHunk`. This keeps
counts, completion, and cross-file advance identical to whole-hunk reject — the "resolves
the last change → completes the file" scenario is covered for free. The action is one
`WorkspaceEdit`, preserving single-undo.

### 5. Cursor/selection resolution reuses Group 1

The command resolves the target hunk from the **active editor + selection start** using
Group 1's cursor-resolution helper, and registers with a default keybinding gated by
`interactiveReview.inReview && editorTextFocus`. No new gating or resolution logic.

## Risks / Trade-offs

- **Off-by-one in line-index math** (1-based hunk positions vs 0-based editor lines) →
  Confined to the pure `splitHunkByRange` helper with direct unit tests.
- **Partial-reject ambiguity in mixed hunks** → Scope to added lines; pure-removal hunks
  fall back to whole-hunk reject; documented.
- **Selection spanning multiple hunks silently doing half the job** → Mitigated by
  Decision 3: resolve the start hunk, log the rest.
- **Recompute produces an unexpected split** (e.g. adjacent identical lines re-align) →
  Bounded here because the baseline is unchanged; the remaining diff is the original hunk
  minus deleted lines. Covered by boundary-spanning and last-change integration tests.

## Open Questions

- Default keybinding chord for `rejectSelection` (decide at implementation to avoid
  conflicts; user-rebindable).
- Whether the deferred partial-**accept** follow-up should reuse `splitHunkByRange` as-is
  or need a richer split (e.g. removed-line indices) — revisit when that change is scoped.
