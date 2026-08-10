# Review UI legibility: why one edit becomes six Accept buttons

Panel findings, 2026-08-09. Convened after a report that the review surface "sometimes
highlights the entire file, but accepting acts as if it had only done a smaller portion —
it's hard to tell when one clicks Accept exactly what one is accepting."

Status (2026-08-10): **diagnosis complete.** One item shipped — EOL-insensitive diffing
(§7, commit `18e80c1`). One item **withdrawn** — gated hunk coalescing (§5 Stage 2 / §8).
Everything else was triaged into the prioritized backlog in [`../todo.md`](../todo.md),
which is the place to look for *what to do next*; this document is the *why*.

---

## 1. The reproduction

Captured live from the working copy, not constructed. A single logical edit to `todo.md`
(rewriting several consecutive paragraphs) produced this from the extension's own engine:

```
hunks: 6
  newStart=17 newLines=3   +3/-4
  newStart=21 newLines=3   +3/-4
  newStart=25 newLines=2   +2/-4
  newStart=28 newLines=2   +2/-5
  newStart=33 newLines=1   +1/-1
  newStart=35 newLines=27  +27/-0
```

The separators are lines 20, 24, 27, 30 — every one a **blank line** — and line 31, a
`---` rule. The rewritten prose kept the same paragraph skeleton, so those blanks matched
as context.

[`computeHunks`](../src/diffEngine.ts) runs jsdiff `diffLines` at **zero context**: a hunk
is a maximal run of changed lines bounded by *any* unchanged line. One blank line is enough
to end a hunk.

The region paints as one continuous block. Clicking the first Accept takes **3 lines**.
Nothing is broken — it is six hunks wearing a trench coat.

The review baseline at the time of the report was mid-edit: it contained the new heading
and intro followed immediately by the *old* body text. That is the fingerprint of a prefix
being accepted and the rest not.

---

## 2. Three structural causes

### 2a. Two diff engines, one surface

`reviewPanel.openDiffEditor` runs `vscode.diff` with `renderSideBySide: false`. **VSCode
computes and paints that diff with its own algorithm** (`diffEditor.diffAlgorithm`, default
`advanced`). The extension **separately** computes hunks with jsdiff to place the
Accept/Discard lenses and to perform the accept splice.

The pixels come from one algorithm; the meaning of the button comes from another. Nothing
reconciles them.

This matters beyond aesthetics: VSCode's advanced algorithm *deliberately merges* changes
separated by short unchanged runs. jsdiff at zero context deliberately does not. The
fragmentation is that difference made visible.

### 2b. The lens floats in the gap

`DiffCodeLensProvider` anchors each lens at `newStart - 1 + newLines` — the line *after*
the hunk — and a CodeLens renders *above* its anchor. With one-line gaps the buttons land
between two changed blocks, visually attached to the block **below** while acting on the
block **above**.

### 2c. Nothing shows a hunk's extent

The lens title is exactly `$(check) Accept`. No line count, no range, no gutter marker, no
hover.

(Correction, 2026-08-10: an earlier draft said the panel shows `@line N` "never the extent".
That is wrong — `media/panel.js:651-655` renders `@line N` *and* `+N -M` per hunk. The real
asymmetry is that the panel states the extent and the lens does not, which makes the fix
cheaper than described: copy the panel's wording. The separate complaint that `@line N`
reads oddly for a multi-line change stands on its own.)

---

## 3. What the panel established

Four agents: three advocates with assigned positions, one skeptic advocating nothing whose
only job was blast radius. Findings below are marked by how well corroborated they are.

### Cross-confirmed (two agents, independently)

**Whole-hunk accept/discard remain correct under coalescing, with no code change.**
`acceptHunk` splices by *line number* and never reads `addedContent`. jsdiff advances the
old and new counters equally across a context run, so a merged hunk's spans stay contiguous
and its interior lines are byte-identical on both sides — the splice is an identity on
them. `discardHunk` is the mirror case.

**The selection paths are broken by coalescing, and must be fixed in the same commit.**
- `rejectSelection` deletes every document line in the selected sub-range, including
  interior *unchanged* lines. The user gets a fresh pending-removal demanding their own
  blank lines and `---` rules back.
- `acceptSelection` inserts at `oldStart - 1 + oldLines`, i.e. past the *entire* merged old
  region. Accepted lines land after the wrong block and interior context lines get written
  into the baseline twice. That is baseline corruption, not a display wart.

Fix: give `ParsedHunk` a `parts: ParsedHunk[]`, and have `resolveSelectionHunk` re-resolve
to the atomic part at the selection start. A part is shaped exactly like a present-day hunk,
so all existing selection arithmetic applies verbatim.

### Verified against the API surface

**There is no stable API to read the diff VSCode computed.** Checked against
`@types/vscode` 1.110: no `LineChange`, no `DiffInformation`, no `DiffEditor`.
`TabInputTextDiff` yields the two URIs and nothing about content. `QuickDiffProvider` runs
the other direction. `vscode.diff` is `void` by contract.

The API that would fix this — `TextEditorDiffInformation` — **is still proposed**. The
project charter is stable-API-only; fork commit `ec138e4` exists specifically to strip a
proposed API. So unifying the engines by reading VSCode's result is *unavailable*, not
merely expensive.

Vendoring VSCode's `defaultLinesDiffComputer` is legal (MIT) but is a several-thousand-line
copy of code that changes every release — it re-creates the drift it would be fixing.

### Single-source (relayed, not independently verified)

One agent sampled every non-merge commit in this repo's history: 667 inter-hunk gaps,
classified by whether all interior lines are "trivial" (whitespace-only, or a lone
`---`/`***`/`___` rule).

| ext | gap=1 | gap=2 | gap=3 | gap>=4 |
|---|---|---|---|---|
| `.md` | n=20, 85% trivial | n=1, 0% | n=4, 25% | 0% |
| `.ts` | n=69, 48% trivial | n=41, 12% | n=33, 3% | 0% |
| `.js` | n=30, 47% trivial | n=16, 19% | n=11, 0% | 0% |

Read with appropriate caution. The shape of the claim — triviality collapsing to ~0 by
gap 3 — is what the recommended threshold rests on.

---

## 4. The disagreement, and what settled it

The minimalist argued: do not touch a correct differ to solve a legibility problem. The
skeptic's blast-radius table appeared to support that:

- N >= 1 breaks `hunkNavigation.test.ts` (fixture gaps are `line 3`, `line 7`)
- N >= 2 breaks `partialAccept`/`partialReject` (gaps are `l2`, `l3`)
- N >= 3 breaks four `diffEngine.test.ts` cases (gaps are `b`, `c`, `d`)
- N >= 5 breaks `keyboardWalk.test.ts`

But the skeptic measured a **raw** threshold and the advocate never proposed one. The
proposed rule is:

> Coalesce iff the gap is <= 3 lines **AND** every interior line matches `/^\s*$/` or
> `/^\s*([-*_=])\1{2,}\s*$/`.

Every gap in every test the skeptic flagged is non-trivial content. **Under the gated rule
the test blast radius is approximately zero.** The disagreement was about different
proposals, not different values.

---

## 5. Staged plan

### Stage 1 — legibility only. No semantic change. No test breakage.

1. **Re-anchor the lens to the hunk's first line.** ~3 lines in `diffCodeLens.ts`. No test
   asserts a lens range. Converts an off-by-one-block ambiguity into the universal
   convention that a lens heads the block beneath it.
2. **Put the extent in the title** — `$(check) Accept +3/-4`, mirroring the panel's existing
   wording so the two surfaces read as one system. Also addresses the standing complaint
   that the panel shows `@line x` even for a multi-line change.
3. **Make the silent no-op loud.** `hunkId` is position-derived (`newStart:newLines:oldStart:oldLines`),
   so every downstream id goes stale after each accept until the provider refires. A click
   on a stale lens currently hits `if (!hunk) { log(...); return; }` and returns with **no
   user feedback** — at four separate boundaries (webview postMessage, CodeLens arguments,
   keyboard commands, jumpToHunk). Reported slowness on a VM widens exactly this window.

*Stage 1 status: not yet implemented. Items 1–2 are backlog item **B**, item 3 is backlog item
**E** in [`../todo.md`](../todo.md) — with narrower scoping than proposed here (the stale-id
window turned out to be one repaint, so the recommendation there is two warnings, not five).*

### Stage 2 — gated coalescing — **WITHDRAWN (2026-08-10)**

> Not implemented and not planned. Whole-file Accept from the panel row already collapses a
> fragmented prose edit to one click, so this bought a cosmetic win over a shipped workaround —
> at the cost of a `computeHunks` rewrite, a *mandatory* companion fix to
> `splitHunkByRange`/`acceptSelection`/`rejectSelection`, and the unresolved §8 question about
> code files. Multi-hunk selection (§6, backlog item **C**) reaches the same goal — one gesture
> per logical edit — without touching the differ. Rationale of record: [`../todo.md`](../todo.md),
> "Dropped: gated hunk coalescing". Reopen only if C ships and fragmentation still bites.

The original proposal, kept for the analysis:

Implement inside `computeHunks` as a post-pass (rename the current body to
`computeAtomicHunks`), so every call site inherits it and lens ids match command ids.
Interior context lines go **into** `addedContent`/`removedContent`, preserving
`addedContent.length === newLines`.

Required companions in the same commit:
- `resolveSelectionHunk` re-resolves to `hunkAtLine(hunk.parts, startLine)`.
- `reviewPanel.buildPanelState` sums `+/-` over `h.parts`, not the merged hunk, or the
  displayed line totals inflate by the gap size.

Free side effect: `hunkAtLine` currently falls a cursor sitting on an interior blank line
*forward* to the next hunk. After coalescing that line is inside the hunk, so a keyboard
accept on it does what the user expects.

### Not now — owning the render surface

`docs/design.md` already rejected custom rendering once, for reinventing syntax
highlighting, word-level diff, and hunk navigation. The modified side being a real
`TextEditor` is what the entire action layer is built on: CodeLens only exists on text
documents, and selection-driven partial accept is defined in terms of `editor.selection`.

Revisit if any of these becomes true:
1. Post-Stage-2 reports keep arriving where paint and lens disagree, with *heterogeneous*
   causes (the signal that the heuristic is chasing an algorithm it cannot catch).
2. `TextEditorDiffInformation` ships stable. Costs nothing to wait for.
3. A roadmap item independently requires owning the surface, so the cost is already paid.
4. The stable-only charter is relaxed for an Insiders build.

---

## 6. Separate bugs surfaced along the way

*All still open; tracked with current scoping in [`../todo.md`](../todo.md) — do not
re-triage them here.*

- **Multi-hunk selection does not work** *(backlog **C**)*. `acceptSelection` resolves a
  selection to *one* hunk, so selecting six paragraphs and accepting takes only the first.
  There is currently no one-gesture way to accept a visual region short of whole-file Accept.
  Fixable at the command layer (~30-40 lines) by iterating every intersecting hunk — an
  alternative route to "one action per logical edit" that does not touch the differ at all.
  With Stage 2 withdrawn, this is now *the* route to that goal.
- **`pendingCount` is sent to the webview and never rendered.** Still true —
  [reviewPanel.ts:198](../src/reviewPanel.ts#L198) populates it; no `media/panel.js` read.
  Adjacent to the standing request that the panel show a file count in its tab title the way
  Problems and Ports do.
- **Stale ids fail silently at four boundaries**, log-only, no toast, no refresh
  *(backlog **E**)*.

---

## 7. "Almost the entire file is highlighted" — reproduced

Second panel, 2026-08-10. Three agents: an archetype sweep over real repo files using the
compiled `computeHunks`, a live run driving the actual extension host and reading
`panelStateForTest()`, and a sources-of-truth audit. The first two never saw each other's
work.

### The headline negative result

**The differ does not mis-align.** This was the leading hypothesis and it is wrong. Measured:

- 300 identical lines, one line inserted at index 3 → **1 hunk, +1/-0**
- 300 near-identical lines, one unique line inserted → **1 hunk, +1/-0**
- 100 repeated 3-line `case:` blocks, one prepended → **1 hunk, +3**
- 30 single-word edits spaced 5 lines apart → 24 hunks, 24 lines, churn **1.0**
- same spaced 2 lines apart → 23 hunks, 23 lines, churn **1.0**

Myers stays minimal. Scattered edits do not smear into a large region. Whatever is
producing the whole-file effect, it is not the diff algorithm losing alignment.

### Signature table

"Footprint" = Σ `max(newLines, oldLines)` — the lines the review model marks changed.
"Churn" = footprint / lines a human would say were edited.

| Signature | Archetype | Measured | Verdict |
|---|---|---|---|
| **1 hunk, ~100% of file** | LF → CRLF | `fileWatcher.ts` 696/697 lines, **1 hunk**; live host: 47/47, 1 hunk | correct, surprising |
| **Many hunks, 78-87%** | whole-file reindent (spaces→tabs) | `fileWatcher.ts` 73 hunks / 603 lines | correct |
| **~29%, enormous hunk count** | strip trailing whitespace | `fileWatcher.ts` **205 hunks** / 205 lines, churn 1.0 | correct, brutal queue |
| **19-45%, prose only** | re-wrap paragraphs, zero words changed | `design.md` 37 hunks / 221 lines @80col | correct, surprising |
| **Add-skewed, scattered** | stale baseline + 1-word edit | `design.md` +89/-14, churn **91** | **diff right, baseline wrong** |
| **~18%, huge hunk count** | curly quotes / em-dash → ASCII | `design.md` **71 hunks** / 79 lines | correct |
| 2x footprint | move a block, no edit | 30 lines highlighted for a 15-line move | inherent to line diff |

The re-wrap number has a diagnostic fingerprint: cost is proportional to distance from the
file's native wrap width. `design.md` (median 90 cols) costs 45.1% re-wrapped to 80 but
34.8% to 90. `README.md` (median 87) costs 42.3% at 80 and 19.1% at 90.

### The mechanism, in one paragraph

`Diff.diffLines` tokenizes by splitting on `\n` and compares tokens with `===`. Everything
else on the line — the `\r`, the indentation, the trailing spaces, where the wrap fell — is
**part of the token**. Convert LF to CRLF and no token in the old sequence equals any token
in the new one, so Myers finds a zero-length common subsequence and emits one delete-all
followed by one insert-all. `computeHunks` merges consecutive added/removed changes with no
context requirement, so the whole file arrives as a **single hunk**. That is the exact
user-visible signature: the entire file highlighted, and *one* entry in the review queue.

Confirmed reachable here: baselines come from `git show :path` in the shadow repo (raw blob
bytes) while current text comes from `fs.readFile(..., 'utf-8')` or `doc.getText()`, and
`computeHunks` receives both raw. There is **no EOL normalization anywhere in `src/`** —
grep for `\r\n`, `eol`, `autocrlf` returns nothing.

### The causes that paint whole-file with no real diff at all

*Cause 1 is backlog item **F**; causes 2 and 3 are both backlog item **A**, which fixes them
with the same ~5 lines. See [`../todo.md`](../todo.md).*

The archetypes above are all cases where the bytes genuinely differ. The audit found three
where the *paint* is whole-file while the model says something small or nothing. These are
closer to the literal complaint and are ordered by how likely they are to fire.

**1. Any working-tree rewrite that leaves `.git/HEAD` textually unchanged.** The branch
watcher compares the *contents* of `.git/HEAD`, which stay `ref: refs/heads/main` across
`git pull`, `merge`, `reset --hard`, `stash pop`, `checkout -- .`, and same-branch rebase.
And even on a real branch switch the handler returns early unless `clearOnBranchSwitch` is
on — default **false**. So: begin review, run `git pull` in the terminal, and every file the
pull touched enters review at whole-file scale for changes the user never made.

**2. The baseline content provider is cached and under-invalidated.** `onDidChange` exists
but `fireBaselineChange` is called only from the five *accept* paths. It is never fired when
`enterReviewing` records a new baseline, nor by `rebuildState`/Refresh, nor by
`clearHunksOnBranchSwitch`, nor by `syncIgnoreState` or `snapshotFile` adopts. Reopening a
diff whose baseline moved through any of those paints against stale cached content.

**3. Accepting the last hunk repaints the file as 100% added.** `finishBaselineAdvance`
calls `exitReviewing`, which **deletes the state entry**; the provider then returns `''` for
that path. `fireBaselineChange` runs *after*, so the diff repaints with an empty left side —
the entire file as one added block — until the async `closeStaleTabs` removes the tab.

### One concrete bug found on the way, and one retracted

- **`acceptHunk` folds the buffer into the baseline; `acceptFileByPath` folds disk.** Accept
  a hunk with unsaved edits in the buffer and the recorded baseline contains text that was
  never written to disk. Undo the buffer and you get hunks you never made. Still open —
  backlog item **D**, where it is upgraded from an undo problem to a data-loss one
  (`scanTrackedIntoState` rebuilds from disk, so a reload resurrects an inverted hunk).
- **RETRACTED: "`discardHunk` writes LF endings unconditionally, leaving a phantom hunk in
  CRLF files."** The reading of the source was right — `originalLines.join('\n') + '\n'`,
  no consultation of `doc.eol` — but the conclusion did not follow, because it depends on
  VSCode behaviour that cannot be established by reading this repo. Probed in the extension
  host: applying a `WorkspaceEdit` containing `'B\n'` to a CRLF document yields `a\r\nB\r\nc\r\n`
  and leaves `doc.eol` unchanged. **VSCode normalizes edit text to the model's EOL**, so the
  LF join is safe. `src/test/integration/eolNormalization.test.ts` now pins that assumption,
  since nothing else would catch it changing — and with an EOL-insensitive differ, a
  regression there would silently rewrite the user's line endings without ever showing a hunk.

### Resolution: EOL-insensitive diffing (implemented)

`computeHunks` now passes `stripTrailingCr: true` to `Diff.diffLines`. A pure EOL conversion
produces zero hunks, and an edit made in the same write as a conversion surfaces as just
that edit.

Deliberately not paired with `ignoreWhitespace` — a whitespace-only change is sometimes
exactly what a reviewer needs to see, so the reindent and trailing-whitespace archetypes
keep costing what they cost.

Two things checked rather than assumed while implementing:

- **The shadow git is byte-exact regardless of `core.autocrlf`.** `snapshot()` pipes content
  through `git hash-object -w --stdin`, which raised the question of whether a Windows user
  with `autocrlf=true` would get LF-normalized baselines against CRLF working files — i.e.
  *every* file permanently showing a whole-file diff. Tested directly with `autocrlf=true`:
  both `hash-object --stdin` (no `--path`, so no attributes, so no filter) and `git show :path`
  round-trip CRLF unchanged. Not a problem; no config hardening needed.
- **`@types/diff@5.2.3` lacks `stripTrailingCr`** though `diff@5.2.2` implements it
  (`lib/diff/line.js`). Handled by module augmentation in `diffEngine.ts` rather than a cast,
  so the call site stays type-checked.

Remaining idea, not implemented: if a single hunk's footprint exceeds ~80% of a file, that
is now a signature of a formatter pass rather than an EOL change. Surfacing that as a named
condition ("whole file reformatted") would beat presenting a 700-line hunk.

---

## 8. The open decision — closed by withdrawing the feature (2026-08-10)

The gate on **code** was the real judgment call. Roughly half of single-line gaps in `.ts`
files here are blank lines, so two edits separated by one blank line inside a function would
merge. For prose that is obviously right. For code it is arguable, and there is a standing
complaint pointing the *other* way ("sometimes it is grabbing bigger chunks of code").

**Resolution:** the question was never answered because coalescing itself was withdrawn (§5
Stage 2). Being unable to settle the code gate cheaply was part of why. If coalescing is ever
reopened, this is the question that must be answered first.
