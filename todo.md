# Known, unfixed

Issues found and deliberately not fixed, with enough context to pick up cold. Ordered by
severity. Everything here is *known* — none of it is a surprise waiting to be rediscovered.

Opened 2026-08-09, from the Phase 4 close-out.

---

# Prioritized: review-UI backlog

Triaged 2026-08-10 against `fc52d93`, after the investigation written up in
[docs/review-ui-legibility.md](docs/review-ui-legibility.md). Every status below was
re-verified against the current tree, not carried over from the investigation.

Ordered by value, and the order is the recommendation — do them top-down, stop wherever the
returns stop being worth it.

## A. Baseline provider serves `''` after the last accept — whole file flashes green

**Do first.** ~5 lines, fires on *every completed file review*.

`finishBaselineAdvance` calls `exitReviewing` when zero hunks remain, which deletes the
state entry ([stateManager.ts](src/stateManager.ts)). The content provider then returns
`fileState?.baseline ?? ''` ([extension.ts:31](src/extension.ts#L31)) — an empty left side.
And `fireBaselineChange` runs on the very next statement in the accept callback
([extension.ts:218](src/extension.ts#L218): `onStateChanged(); fireBaselineChange(filePath); walkAfterResolve(filePath)`),
so the diff repaints the entire file as one added block while the async `closeStaleTabs`
is still catching up.

This is a real contributor to the "sometimes it highlights the entire file" report, and
unlike the EOL cause it is on the happy path.

**Fix:** no-op `fireBaselineChange` when the file is no longer reviewing, and fire once at
the top of `openDiffEditor`. The second half covers `enterReviewing`, `rebuildState`/Refresh,
`clearHunksOnBranchSwitch` and the adopt paths in one stroke, since every diff opens through
there — today `fireBaselineChange` is called only from the five accept paths, so a diff
reopened after any of those paints against stale cached content.

## B. CodeLens anchoring and titles

**Do second.** ~5 lines, one file, no test asserts a lens range.

- [diffCodeLens.ts:43](src/diffCodeLens.ts#L43) anchors at `newStart - 1 + newLines` — the
  line *after* the hunk — and a lens renders *above* its anchor, so with short gaps the
  buttons float between two changed blocks, visually attached to the block below while
  acting on the block above. Anchor to the hunk's first line instead.
- [diffCodeLens.ts:50](src/diffCodeLens.ts#L50) is literally `'$(check) Accept'`. Add the
  extent: `Accept +3/-4`, mirroring the wording the panel already uses at
  [panel.js:653-655](media/panel.js#L653-L655).

## C. Multi-hunk selection accept/reject

**Do third.** ~30-40 lines, command layer only, no differ change.

[commands.ts:497-504](src/commands.ts#L497-L504) already computes the set of hunks a
selection spans, then deliberately acts on one and logs the overreach. Iterate the set
instead. This delivers "one gesture per logical edit" — the goal that motivated the
coalescing idea below — without touching hunk arithmetic.

## D. `acceptHunk` folds the buffer; `acceptFileByPath` folds disk

**Do fourth.** 3-line guard now, proper fix later.

`acceptHunk` folds `doc.getText()` into the baseline while `acceptFileByPath` folds
`fs.readFileSync`. Accept with a dirty buffer and the baseline holds text never written to
disk. Worse than an undo problem: `scanTrackedIntoState` rebuilds from **disk**
([stateManager.ts:218](src/stateManager.ts#L218)), so any reload resurrects the file with an
inverted hunk demanding you re-remove text that was never there.

The extension actively invites the dirty-buffer case, since the modified side of the review
diff *is* the real editor.

**Fix now:** refuse on `doc.isDirty` with a warning. **Fix properly later:** `await doc.save()`
before folding, which makes `acceptHunk` async and ripples to four call sites.

## E. Stale hunk ids fail silently

**Do fifth, cheap version only.**

`hunkId` is position-derived, so ids go stale after every accept. Both lens paths hit
`if (!hunk) { log(...); return; }` and return with no user feedback. Narrower than it first
appeared — `onStateChanged` fires the lens provider synchronously, so the window is one
repaint — but it is exactly the window that widens on a slow VM, which matches the reported
"Accept/Discard showing up much more slowly".

**Fix:** one `showWarningMessage` at the two lens entry points. Not all five silent returns,
and do not attempt re-resolution by position — that is a semantic change.

## F. `git pull` mid-review floods the queue

**Do last, and only the detection half.**

The branch watcher compares the *text* of `.git/HEAD` ([extension.ts:444](src/extension.ts#L444)),
which does not change on pull, merge, stash pop, `reset --hard`, or same-branch rebase. So
every file such a command rewrites enters the queue at whole-file scale for changes the user
never made.

Two cautions, both load-bearing:

1. `extension.ts:442` returns early unless `clearOnBranchSwitch`, which **defaults false** —
   so the entire branch-switch subsystem is inert for anyone who has not toggled it.
2. Do **not** fix this by auto-clearing. `clearHunksOnBranchSwitch` re-baselines *all* files,
   which would silently discard genuine in-progress review entries the pull never touched.
   That is almost certainly why the default is false.

**Scope:** resolve `.git/HEAD` through `refs/heads/*` and `packed-refs` (or shell out to
`rev-parse`), detect the change, and *notify* — "working tree changed outside your edits —
Refresh?". Do not flip the default.

## Dropped: gated hunk coalescing

Merging hunks separated by <= 3 blank/rule lines was recommended and is now **withdrawn**.

It would fix one prose edit fragmenting into six Accept buttons. But whole-file Accept from
the panel row already collapses that to one click, so the item buys a cosmetic improvement
over a shipped workaround — at the cost of a `computeHunks` rewrite, a *mandatory* companion
fix to `splitHunkByRange`/`acceptSelection`/`rejectSelection` (which index by document line
and would corrupt the baseline or delete unchanged interior lines under a merged hunk), and
an unresolved design question about whether the gate should apply to code, where roughly half
of one-line gaps are blank lines.

Item C above is the cheap route to the same goal. Reopen this only if C ships and the
fragmentation still bites.

---

## 1. Three independent answers to "is this file new"

**Severity:** low — no known wrong behavior today; a drift hazard.

Fixing the enable-window race (see below) left the codebase with three separate places that
decide whether an on-disk file with no baseline is a *new* file or a *pre-existing* one:

- [`handleDiskCreate`](src/fileWatcher.ts#L390) — new, unless the enable snapshot is running.
- [`handleDiskChange`](src/fileWatcher.ts#L566) — never new; silently adopts as baseline.
- [`adoptUntrackedFiles`](src/stateManager.ts#L234) — unconditionally new, no exceptions.

The third is reached from `rebuildState`, i.e. the `interactiveReview.refresh` command. It
has no guard and no comment tying it to the other two. It isn't wrong today only because
refresh doesn't run concurrently with enable in practice — a fact nothing enforces.

**Found by:** a test that used `waitForConditionNudged` (which issues a refresh) to observe
the watcher's classification. The refresh's adopt beat the watcher and won.

**If you touch this:** the useful move is probably not a fourth guard but making the
decision one function that all three call.

---

## 3. `readBatch` docstring claims binary files are skipped — they are not

**Severity:** low — wrong comment, correct behavior.

[stateManager.ts:125](src/stateManager.ts#L125) states the skip is "deliberate and
load-bearing: binary files and unreadable files ... must not abort the batch." But
`fs.promises.readFile(fp, 'utf-8')` does not throw on binary input — it returns lossy
U+FFFD replacement text, which is then snapshotted as a baseline. Only genuinely
*unreadable* files reach the `catch`.

The behavior predates the refactor and may well be fine. The problem is the comment
asserting a guarantee that isn't there, on a helper now shared by three call sites. Either
trim the claim to what's true, or add a real binary sniff if binary baselines are actually
undesirable — but decide, don't leave the comment lying.

---

## 4. Test scaffolding compensates for a retracted premise

**Severity:** low as a bug, medium as a blind spot — five tests currently cannot fail.

[helpers.ts](src/test/integration/helpers.ts) carries `WAIT_FLOOR_MS = 15000` and
`waitForConditionNudged`, both built on the belief that VS Code's `createFileSystemWatcher`
drops external raw-fs create/delete events on headless Linux. **That premise was retracted
2026-08-10** — see [docs/design.md §4c.1](docs/design.md), which now carries the measurements.

The blind spot: `waitForConditionNudged` drives `interactiveReview.refresh` every poll, so the
five brand-new-external-file tests assert the *synchronous rescan* works, not the watcher.
They would stay green if watcher delivery broke entirely.

**The instrument:** [watcherProbe.test.ts](src/test/integration/watcherProbe.test.ts) measures
raw `onDidCreate`/`onDidChange`/`onDidDelete` delivery plus the end-to-end no-nudge path. It
self-skips unless `WATCHER_PROBE=1`, so it never runs in the normal suite:

```sh
WATCHER_PROBE=1 WATCHER_PROBE_ROUNDS=30 npx vscode-test --grep "watcher probe"
```

Measured on an idle headless Lima VM at *stock* inotify limits: 30/30 on every event type,
p50 ~130ms. The July failures were inotify starvation on a saturated workstation (~145 fds in
use against a 128 cap), not a platform limit.

**Sequence if you pick this up:** (1) reproduce the one unexplained flake seen in two VM suite
runs — loop it ~5× and *save full logs*, don't grep them away; (2) drop the nudge from the five
watcher tests so they test the watcher; (3) then reconsider the 15s floor. Delete the probe once
step 2 lands and the regular tests are honest — at that point it is redundant, and the starvation
check is a shell one-liner (`cat /proc/sys/fs/inotify/max_user_instances` vs. actual fd usage).
If it *stays*, give it assertions — it currently only checks that it ran.

---

we need to confirm accept/discard big buttons that do all files at once
it seem,s like sometimes it is grabbing bigger chunks of code
It shows @line x even when its a multiline change
Accept/Discard showing up seems to be occurring much more slowly (possibly because the repo I'm workign in is on a VM?)
if edits overlap each other, we should have an option that allows one to show a single edit at a time
interactive review doesn't show the number of fiules in (x) like say problems or ports do