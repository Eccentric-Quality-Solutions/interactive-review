# Known, unfixed

Issues found and deliberately not fixed, with enough context to pick up cold. Ordered by
severity. Everything here is *known* — none of it is a surprise waiting to be rediscovered.

Opened 2026-08-09, from the Phase 4 close-out.

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

## ~~2. Files created just before "Begin review" can be treated as new~~ — FIXED

Create a file, then immediately Begin review, and it could land in the queue as an
entirely-new file (null baseline, every line an addition) instead of a quiet baselined file.
`handleDiskCreate` consulted the git baseline before declaring a file new, so a create event
arriving while `snapshotWorkspace` was still running found no baseline and fell through to
the new-file path.

Fixed with a `_snapshotInProgress` flag on `FileWatcher` (`beginSnapshot`/`endSnapshot`,
raised across the whole enable window in `enableReview`) that sends the no-baseline case to
the same silent-adopt branch `handleDiskChange` already used. Deliberately *not*
`suppressAll`, which would also blind the watcher to deletes and to changes on
already-baselined files.

Two follow-on bugs the fix introduced, both since fixed: `snapshotWorkspace` ran its
`snapshotBatch` off the git queue and so raced the adopt path for `.git/index.lock` (both
call sites swallow the error, losing the baseline silently); and `enableReview` resolved
without draining the queue, breaking its documented "baseline is on disk when this resolves"
contract for exactly the files the window protects.

**Residual, by construction:** a file created after `collectWorkspaceFiles` returns but
before `snapshotBatch` finishes gets no baseline at all, and its next change is absorbed by
`handleDiskChange`'s Cause B adopt. Closing it means making the snapshot atomic against the
filesystem, which it cannot be. Documented at the adopt branch.

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

we need to confirm accept/discard big buttons that do all files at once
it seem,s like sometimes it is grabbing bigger chunks of code
It shows @line x even when its a multiline change
Accept/Discard showing up seems to be occurring much more slowly (possibly because the repo I'm workign in is on a VM?)
if edits overlap each other, we should have an option that allows one to show a single edit at a time
interactive review doesn't show the number of fiules in (x) like say problems or ports do