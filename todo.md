# Known, unfixed

Issues found and deliberately not fixed, with enough context to pick up cold. Ordered by
severity. Everything here is *known* — none of it is a surprise waiting to be rediscovered.

Opened 2026-08-09, from the Phase 4 close-out.

---

## 1. Files created just before "Begin review" can be treated as new

**Severity:** medium — user-visible, produces a wrong review queue.

Create a file, then immediately run Begin review, and the file can show up in the queue as
an entirely-new file (null baseline, every line an addition) instead of a quiet baselined
file with nothing pending.

**Mechanism.** [`onDiskCreate`](src/fileWatcher.ts#L337) consults the git baseline before
declaring a file new. If the watcher's create event lands *while* `snapshotWorkspace` is
still running, there is no baseline yet, so the file falls through to the new-file path and
gets `baseline: null`.

**Why it's plausible that nobody hit it:** the window is the duration of the enable
snapshot, and normal use has files sitting on disk long before Begin review is invoked.
It becomes much likelier under agent-driven use, where files may be written seconds before
the review is opened.

**Evidence.** Found while writing `keyboardWalk.test.ts`: the first run reported
`queue=3 files, +27/-0` immediately after Begin review and before any edit. Inserting a
500ms settle before enable made it go to `queue=0`. That workaround is still in the test —
see the comment at the `waitForCondition` guards.

**Likely fix.** Activation already guards `load()` with `fileWatcher.suppressAll()`
([extension.ts:156](src/extension.ts#L156)); the enable path has no equivalent. Wrapping
`snapshotWorkspace` in the same suppression is the obvious symmetry. Needs care: the
suppression must be released even if the snapshot throws, and `resumeAll` must not swallow
genuine creates that happened during the window.

---

## 2. New-then-deleted file routes to the broken diff path

**Severity:** low — narrow race, self-heals.

[`isDeleted`](src/stateManager.ts#L362) deliberately excludes `baseline === null`, so a file
that entered state as untracked-new and was then deleted before the watcher's `onDidDelete`
cleaned it up is `isNew: true, isDeleted: false`. `openDiffEditor`
([reviewPanel.ts:339](src/reviewPanel.ts#L339)) then falls through to
`vscode.diff(baselineUri, file://<missing>)` — the "file not found" error the deleted-file
surface exists to prevent.

The watcher normally wins the race (covered by "external file deletion of new file (null
baseline) cleans up state"). `advanceToNextFile` firing ahead of it is the window.

**Likely fix.** Guard the `openDiffEditor` call site on `!fs.existsSync(filePath)` rather
than on `isDeleted`, which answers a narrower question than the call site is asking.

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

## 4. `collectUntrackedFiles` fans out over every workspace file

**Severity:** low — allocation, not risk.

[stateManager.ts:151](src/stateManager.ts#L151) materializes every non-ignored workspace
file, then fires `fs.promises.access` for all of them in one unbounded `Promise.all`,
discarding the result for every tracked file. The pre-refactor version pruned tracked files
*inside* the walk and awaited sequentially.

No EMFILE cliff — `access` doesn't hold a descriptor — so this is wasted allocation rather
than a failure mode. `trackedSet` is already in hand, so filtering before the fan-out is
free:

```ts
await Promise.all(all.filter(f => !trackedSet.has(f)).map(async full => { ... }));
```

Also note `untracked.push` inside concurrent callbacks makes result ordering
nondeterministic where the old walk was deterministic. Only affects log output and Map
insertion order.

---

we need to confirm accept/discard big buttons that do all files at once
it seem,s like sometimes it is grabbing bigger chunks of code
It shows @line x even when its a multiline change
Accept/Discard showing up seems to be occurring much more slowly (possibly because the repo I'm workign in is on a VM?)