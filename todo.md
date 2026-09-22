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

**Re-ordered 2026-09-22 on usage evidence** (see "Parked" below): the log shows review is
driven almost entirely by CodeLens clicks, so the items that change the CodeLens experience
come first.

## H. Accept/Discard CodeLens appears slowly

User note: slower than expected, possibly because the repo is on a VM. Measure before
changing anything: time from a disk write to the lens rendering, split into watcher
delivery, the `perPath` queue, git reads, and `computeHunks`. Suspects: the 150ms panel
debounce plus 50ms watcher debounce (extension.ts), `shouldIgnore` recompiling its matcher
per call (see §6), and git subprocess latency on a VM filesystem. On Remote-SSH the
extension runs on the VM, so its logs are there too.

## I. "Sometimes it is grabbing bigger chunks of code"

User note. Almost certainly hunk size, not a selection bug: jsdiff merges changes with no
unchanged line between them into one hunk, so one Accept takes more than the user expected.
[docs/review-ui-legibility.md](docs/review-ui-legibility.md) covers the mechanism. Needs a
concrete example from real use (the log records each hunk's id, which encodes its
position and size) before deciding whether anything should split hunks.

## F. `git pull` mid-review floods the queue

**Only the detection half.**

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

## Parked: no evidence of use (C, D)

Parked 2026-09-22 on usage evidence, not merit. The extension's own log across every local
VS Code session from 2026-08-17 to 2026-09-22 (25 sessions, ~120k lines) shows **852** hunk
actions from CodeLens, 3 from the panel, and **0** from keybindings or selection commands.
C only arises from a selection command spanning hunks: 0 occurrences (`selection spans`).
D's refusal (`unsaved edits, refusing`) fired 0 times across 72 accepts after it shipped.
Remote sessions (Remote-SSH to a VM) log on the remote host and are not in these numbers.

Reopen either one if the log starts showing the situation. The investigation and panel
notes below are kept so the work can resume cold. The same evidence also downgrades
keyboard-flow polish in general: CodeLens latency and hunk size are what this user feels.

### C. Multi-hunk selection accept/reject

Parked; see above. (The original ~30-40 line estimate was low; see the investigation.)

[commands.ts:497-504](src/commands.ts#L497-L504) already computes the set of hunks a
selection spans, then deliberately acts on one and logs the overreach. Iterate the set
instead. This delivers "one gesture per logical edit" — the goal that motivated the
coalescing idea below — without touching hunk arithmetic.

**Investigated 2026-09-22.** The code is now in `resolveSelectionHunk`
([commands.ts](src/commands.ts)). "Iterate the set" is right, but not by calling the
single-hunk path in a loop: each call re-diffs, and hunk coordinates computed before the
first resolve are stale after it. Compose the pure functions in `hunkApply` instead, in one
pass over hunks computed once:

- **Accept** never edits the buffer, so every hunk's `newStart` stays valid. Fold with
  `acceptLinesBaseline` **bottom-up** (descending `oldStart`) so each insertion leaves the
  anchors above it untouched. One baseline write.
- **Reject** never edits the baseline. Apply `rejectLinesText` bottom-up (descending
  `newStart`) to the text, then one `minimalSplice`, giving one `WorkspaceEdit`, one undo
  entry and one save. That also beats N saves on the self-edit guard.
- Add a multi-hunk property to `hunkApply.test.ts` (random selection across several hunks;
  converges; nothing outside the selection changes), plus a mutation in
  `scripts/mutation-check.mjs` that processes top-down. The composition order is exactly the
  kind of invariant this repo has lost to prose before.
- `partialAccept.test.ts:86` and `partialReject.test.ts:69` pin the current start-only
  behaviour and must be rewritten.

**Decision needed first — what happens to red lines inside the selection.** Selection
actions only touch *added* lines; removed lines always stay pending. With one hunk that is
a feature (partial accept). Across several it is surprising: select a region and press
`Alt+Shift+A`, and every replacement hunk inside it still shows its red lines. Removed lines
are view zones, not document lines, so the user cannot select them directly. Recommended
rule: a hunk whose added lines are all selected and whose anchor lies strictly inside the
selection resolves **whole** (removals included); the hunks at the selection's two edges
keep partial semantics. A pure-removal hunk counts as covered when
`selStart < newStart <= selEnd` (its red block renders between those lines). Note the
current overlap test uses `max(1, newLines)`, which makes a pure removal count as "spanned"
when the selection merely touches the context line after it.

**Panel review, 2026-09-22 — corrections to the above:**
- *Composition verified.* 300k fuzzed seeds (16k multi-hunk selections mixing whole and
  partial resolution, with CRLF, no-final-newline and BOM cases): bottom-up had 0
  violations; top-down failed ~12.8k times each for accept and reject. It holds because
  jsdiff always leaves at least one context line between hunks, so only the bottom-most
  splice can reach EOF.
- A hunk resolved *whole* must use `acceptHunkBaseline` / `discardHunkText`, not the
  `*Lines*` partial functions.
- *Edge rule, from the UX seat:* "strictly inside" is wrong for how people select. They
  start on a hunk's first green line, which leaves the first hunk half-pending. Better:
  in a multi-hunk selection, any hunk whose added lines are *all* selected resolves whole,
  edges included. Only a hunk the selection actually cuts through stays partial. A
  selection within one hunk keeps today's behaviour. The strict anchor test applies only
  to pure-removal hunks, clamped so a removal at line 1 or at EOF can still be covered.
- Keep the `keepsUnbaselinedFile` and dirty-buffer guards.
- *Cheap interim* if C waits: replace the log-only overreach with a visible "resolved 1
  of 3 changes" status message.

### D. `acceptHunk` folds the buffer; `acceptFileByPath` folds disk

Parked; see above. The refusal guard shipped and stays.

`acceptHunk` folds `doc.getText()` into the baseline while `acceptFileByPath` folds
`fs.readFileSync`. Accept with a dirty buffer and the baseline holds text never written to
disk. Worse than an undo problem: `scanTrackedIntoState` rebuilds from **disk**
([stateManager.ts:218](src/stateManager.ts#L218)), so any reload resurrects the file with an
inverted hunk demanding you re-remove text that was never there.

The extension actively invites the dirty-buffer case, since the modified side of the review
diff *is* the real editor.

**Fixed for now (2026-09-21):** hunk and selection Accept refuse a dirty buffer with a
warning (`refusesDirtyAccept`). **Still to do properly:** `await doc.save()` before folding,
which makes `acceptHunk` async and ripples to four call sites, and lets Accept work on unsaved
edits instead of refusing.

**Investigated 2026-09-22.** Saving first is sound, with three rules:

1. **Resolve after the save, never before.** Look up `fileState` and the hunk by id only
   once `save()` has resolved. That also makes a double `Alt+A` during the save harmless:
   the second call finds its id gone and stops.
2. **Abort if the save changed the text.** Save participants (`formatOnSave`,
   `codeActionsOnSave`, `trimTrailingWhitespace`) rewrite the buffer before it hits disk.
   A hunk id then fails to match (safe but mute), and for `acceptSelection` the selection's
   line numbers point at *different lines*, so it would accept the wrong ones. Compare
   `getText()` before and after the save; if they differ, stop and say so.
3. **Abort on `save() === false`.** That is what a vetoed save returns, including VS Code's
   "file is newer on disk" conflict. It is the likely case here: the agent wrote the file
   again while the user had unsaved edits in it.

No self-edit guard is needed around the save. A save of a *reviewing* file does not adopt
anything; the watcher only calls `recomputeHunks` (fileWatcher.ts, the `reviewing` branch
of `handleDiskChange`). That is synchronous after its read, so it cannot interleave with
the accept. The user's other unsaved edits stay pending as hunks, which is what happens to
them today on any save of a reviewing file. (So the README's "edits you save by hand are
adopted" holds for idle files only.)

Ripple: `acceptHunk` becomes async. Callers are the CodeLens and keybinding handlers in
extension.ts (switch to `void …catch(reportCommandFailure(…))` like `discardHunk`), the panel
handler (await it), and `acceptSelection`'s pure-removal fallback (await it). There are
four direct calls in the integration tests. `reviewCommands.test.ts:56` ("refuses to accept a
hunk while the file has unsaved edits") inverts into "saves, then accepts"; add a test for
rule 2 with a format-on-save stand-in, via `onWillSaveTextDocument` + `waitUntil`.

Related, same shape: `acceptFileByPath` reads disk, so accepting a file with unsaved edits
takes the disk version, and the edits are then adopted silently on their next save
(idle-file policy). Saving first there too would make file-level and hunk-level Accept agree.

**Panel review, 2026-09-22 — additions:**
- **Guard the save.** Call `save()` only when `doc.isDirty`. Wrap it in try/catch: it can
  *reject* (readonly, EACCES), not just return false.
- **The "newer on disk" trap.** After the abort, VS Code's own error stays up with an
  **Overwrite** button. Clicking it destroys the agent's newer write. The abort message
  must warn against that, or offer Compare.
- **Format-on-save is common.** Word rule 2's abort as a next step ("Saved; the formatter
  changed foo.ts — press Accept again"). The second press succeeds, since the buffer is
  now clean.
- **Document the side effect.** Accept writes all unsaved edits in that file to disk, so
  the agent, hot reloaders and test watchers can see half-typed code. Reject already
  saves the whole file, so this makes the two symmetric.
- **Verified:** last-hunk dirty accept adopts cleanly, since the save's late event takes the
  manual-save path with matching content. An agent write coalesced into the same event
  still goes to review.
- **Extra tests:** stubbed `save()` false and rejecting (baseline unchanged); a dirty
  last-hunk accept followed by reload (matches memory); a dirty accept of a file with a BOM.
- **Cheap interim** (product seat): add a **Save** button to the existing refusal warning.
  Most of the value, with no async ripple.

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

## 5. `consumeManualSave` deletes whichever save token the path holds

**Severity:** low — no observed failure; a narrow race.

It takes the token by path, not by identity. The wrappers sample the token when an event
arrives, so a second save landing any time between that and the consume — including while
the handler waits behind an earlier event for the path, and during the create handler's
baseline read — loses its token to the first event. The
second save's change event then looks external and is reviewed instead of absorbed: a
spurious hunk on the user's own typing, the safe direction. The wrappers already release by
identity (`releaseSaveToken`); consuming should match the token the handler started with.
Needs its own test and mutation.

---

## 4. Test scaffolding compensates for a retracted premise

**Severity:** low.

[helpers.ts](src/test/integration/helpers.ts) carries `WAIT_FLOOR_MS = 15000`, built on the
belief that VS Code's `createFileSystemWatcher` drops external raw-fs create/delete events on
headless Linux. **That premise was retracted 2026-08-10** — see
[docs/design.md §4c.1](docs/design.md), which carries the measurements. The July failures were
inotify starvation on a saturated workstation, not a platform limit.

The nudge was dropped from the five watcher-delivery tests on 2026-09-21 (they now use
`waitForWatcher`). What remains:

1. Reproduce the one unexplained flake seen in two VM suite runs — loop it ~5× and *save full
   logs*, don't grep them away.
2. Reconsider the 15s floor.
3. Delete [watcherProbe.test.ts](src/test/integration/watcherProbe.test.ts) (self-skips unless
   `WATCHER_PROBE=1`). With the regular tests honest it is redundant, and the starvation check
   is a shell one-liner (`cat /proc/sys/fs/inotify/max_user_instances` vs. actual fd usage). If
   it *stays*, give it assertions — it currently only checks that it ran.

---

## 6. Hardening carried over from the 2026-09-20 code review

**Severity:** low, each one. Triaged 2026-09-22. These were kept because each is a small fix
for a failure that is silent or blocks Begin outright. The full review is in git history:
`git show 0e7c707:docs/code-review-2026-09-20.md`. Ordered by payoff.

1. **Isolate git from the user's environment and config.** Only `commit.gpgsign` and
   `core.hooksPath` are pinned ([baselineGit.ts:139](src/baselineGit.ts#L139)). A `required`
   clean filter from global config (Git LFS) fails Begin review outright. `core.fsmonitor`
   runs, and an inherited `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` (VS Code launched from a
   git hook) redirects the baseline repo. Fix: strip `GIT_*` from the child env, set
   `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, and pin a commit identity.
   `GIT_CONFIG_GLOBAL` needs git ≥ 2.32.
2. **Bound `readBatch` concurrency.** [stateManager.ts:239](src/stateManager.ts#L239) opens
   every workspace file at once. Under a low `ulimit -n` the excess fails with EMFILE and is
   counted as "unreadable", so those files are silently left unbaselined. This box has already
   shown fd/inotify exhaustion. Use the same limiter as the `hash-object` batch.
3. **`ls-files` without `-z`.** [baselineGit.ts:383](src/baselineGit.ts#L383),
   [:433](src/baselineGit.ts#L433) and [:580](src/baselineGit.ts#L580) parse C-quoted output.
   `core.quotepath=false` covers only bytes ≥ 0x80, so names containing `"`, `\`, a tab or a
   newline are skipped on load, missed by `renameFile` and missed by a directory delete. Add
   `-z` and split on `\0`, as the subtree `ls-tree` at :607 already does.
4. **Baselines over 10 MB read back as missing.** `maxBuffer` caps `git show`
   ([baselineGit.ts:148](src/baselineGit.ts#L148)), but `hash-object` has no cap. A large text
   file snapshots fine and then reviews as unbaselined. Either skip files over the cap at
   snapshot time or raise the cap on reads. The two limits just need to agree.
5. **Failures that are only logged.** A failed `syncIgnoreState` still makes Refresh report
   success, and `removeFileBatch` never re-throws. Surface both. (A failed branch-switch
   snapshot also clears state first, but that subsystem is off by default; see F.)

Also folded into **H** above: `shouldIgnore` recompiles its matcher per call, and
`collectGitignores` walks `.git` / unignored `node_modules` synchronously per gitignore event.

**Considered and dropped:**
- Save tokens for files under `files.watcherExclude` never release. Hand-saves there are rare,
  and the leak is bounded by the user's own saves.
- CRLF-baseline discard into an LF document can take two passes. It is cosmetic, and every
  generated case converged.
- `renameFile` bypasses `PathSerializer`, so a handler in flight can leave a phantom "deleted"
  entry. The window is one `git cat-file` wide, and fixing it honestly needs a
  forced-interleaving test.
- End review during Begin's snapshot shows a misleading "retry" message. Nothing is damaged.
- The review's "structural note" (assert invariants, don't argue them in prose). It is already
  policy in [docs/test-strategy.md](docs/test-strategy.md).

---

we need to confirm accept/discard big buttons that do all files at once — **done 2026-09-22 for Discard All** (modal with counts, `confirmAndDiscardAll`); Accept All deliberately left unconfirmed, since it never changes file contents
it seem,s like sometimes it is grabbing bigger chunks of code
Accept/Discard showing up seems to be occurring much more slowly (possibly because the repo I'm workign in is on a VM?)
if edits overlap each other, we should have an option that allows one to show a single edit at a time
interactive review doesn't show the number of fiules in (x) like say problems or ports do — **done 2026-09-22** (item G)