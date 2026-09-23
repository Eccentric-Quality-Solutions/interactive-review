# Known, unfixed

Open items only, a few lines each: what is wrong, how to close it. The 2026-09-20 code
review is at `git show 0e7c707:docs/code-review-2026-09-20.md`.

Ordered by severity within each section.

---

## Correctness

### 1. Ignore-sync can adopt a new file before its create event arrives

**Severity: medium. Found 2026-09-23** by the integration test "discard new file (null
baseline) deletes the file" ([deleteRestore.test.ts](src/test/integration/deleteRestore.test.ts)),
which failed 1 in 1 runs on a healthy inotify budget (1024 limit, 138 in use).

`syncIgnoreState` snapshotted the file 50ms before `onDiskCreate` ran, so the create found a
baseline and the file entered review as an edit of itself instead of as a witnessed create.
Discard then keeps it. Extension log:

```
12:26:30.678Z syncIgnoreState: adding 1 file(s): new-discard.txt
12:26:30.725Z onDiskCreate(new-discard.txt): fileState=undefined
12:26:30.745Z onDiskCreate(new-discard.txt): gitBaseline='17 chars'
12:26:30.746Z onDiskCreate(new-discard.txt): enterReviewing
```

To close: find what triggered the sync (a leftover `.gitignore` or settings event from the
previous test is the likely source), then decide whether `syncIgnoreState` should skip files
younger than the current session or whether the create handler should treat "baseline equals
disk content, no witness" as a create. Needs a test that forces the interleaving.

### 2. The ignored-rename branch has no integration coverage

**Severity: low. Noted 2026-09-22.** `FileWatcher.onWillRenameFiles` takes a file out of
review when the rename target is ignored. The decision is pinned by
`reloadEqualsMemory.test.ts` ("renaming into an ignored location") plus a source guard; the
real handler is not driven end to end.

To close: add a case to `rename.test.ts` that renames a reviewed file into a gitignored
directory and asserts the entry leaves review and a Refresh agrees.

### 3. A large directory dropped into the workspace floods the queue

**Severity: low, behaviour change noted 2026-09-22.** `handleDiskCreateTree` walks the whole
subtree of a created directory. With `respectGitignore` off there is no `node_modules`
backstop (`DEFAULT_IGNORE_PATTERNS` is only `.git`). Deliberately not capped: a silent cap is
the lossy bug the walk fixes. If it bites, the fix is a visible prompt ("1,240 new files in
`vendor/`, review them?"), not truncation.

### 4. `consumeManualSave` deletes whichever save token the path holds

**Severity: low, no observed failure.** It consumes by path, not identity, so a second save
landing between sampling and consume loses its token and is reviewed instead of absorbed.
Safe direction (a spurious hunk on the user's own typing). To close: consume the token the
handler started with, as `releaseSaveToken` already does; add a test and a mutation.

### 5. Hardening from the 2026-09-20 review

Each is small and silent when it fails. Ordered by payoff.

1. **Isolate git from the user's environment.** Strip `GIT_*` from the child env, set
   `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, pin a commit identity. Only
   `commit.gpgsign` and `core.hooksPath` are pinned today ([baselineGit.ts](src/baselineGit.ts)).
2. **Bound `readBatch` concurrency** ([stateManager.ts](src/stateManager.ts)). Opens every
   file at once; EMFILE is counted as "unreadable" and the file is silently unbaselined. Use
   the `hash-object` limiter.
3. **Baselines over 10 MB read back as missing.** `maxBuffer` caps `git show` but not
   `hash-object`. Make the two limits agree.
4. **Failures that are only logged.** A failed `syncIgnoreState` still reports Refresh
   success; `removeFileBatch` never re-throws. Surface both.

Done since the review: `ls-files -z` everywhere (f968dcd).

---

## Review UI

### H. Accept/Discard CodeLens appears slowly

User note; possibly VM latency. Measure before changing: disk write to lens render, split
into watcher delivery, `perPath` queue, git reads, `computeHunks`. Suspects: 150ms panel +
50ms watcher debounce, `shouldIgnore` recompiling its matcher per call, git on a VM
filesystem.

### I. "Sometimes it is grabbing bigger chunks of code"

User note. Almost certainly hunk size: jsdiff merges changes with no unchanged line between
them. Needs a concrete example from real use (the log records each hunk id) before deciding
whether to split hunks. See [docs/review-ui-legibility.md](docs/review-ui-legibility.md).

### F. `git pull` mid-review floods the queue

The branch watcher compares the text of `.git/HEAD`, which does not change on pull, merge,
stash pop or same-branch rebase. `clearOnBranchSwitch` defaults false, so the subsystem is
inert for most users. Scope: resolve HEAD through `refs/heads/*` and `packed-refs`, detect
the change, and *notify* ("working tree changed outside your edits, Refresh?"). Do not
auto-clear and do not flip the default.

### Parked on usage evidence: C, D

Log evidence 2026-09-22 (25 sessions): 852 hunk actions from CodeLens, 3 from the panel, 0
from keybindings or selection commands. Reopen if the log starts showing them.

- **C. Multi-hunk selection accept/reject.** Compose accept and reject bottom-up over
  hunks computed once; top-down fails because each splice moves the anchors below it. This
  was fuzz-verified on 2026-09-22 but the script is gone, so write the property in
  `hunkApply.test.ts` before relying on it. Edge rule: a hunk whose added lines are all
  selected resolves whole, edges included; only a hunk the selection cuts through stays
  partial. Cheap interim: a visible "resolved 1 of 3 changes" message.
- **D. Accept with a dirty buffer.** Refusal guard shipped. Proper fix: save first, then
  look up the hunk; abort if `save()` returned false or changed the text (format-on-save
  shifts selection line numbers). After a "newer on disk" abort VS Code's own dialog offers
  Overwrite, which destroys the agent's newer write, so the abort message must warn against
  it. Cheap interim: a Save button on the refusal warning.

### Dropped

- **Gated hunk coalescing.** Whole-file Accept already collapses a fragmented prose edit to
  one click; the coalescing rewrite would also force a `splitHunkByRange` rewrite. Item C is
  the cheap route to the same goal.
- **Save tokens under `files.watcherExclude` never release.** Bounded by the user's saves.
- **CRLF discard into an LF document can take two passes.** Cosmetic; every case converged.
- **`renameFile` bypasses `PathSerializer`.** One `cat-file` wide; needs a forced-interleaving
  test to fix honestly.
- **End review during Begin's snapshot shows a misleading "retry" message.** Nothing damaged.

---

## User notes

- ~~confirm accept/discard big buttons that do all files at once~~ done 2026-09-22 for
  Discard All; Accept All deliberately unconfirmed (never changes file contents)
- it seems like sometimes it is grabbing bigger chunks of code (item I)
- Accept/Discard showing up much more slowly, possibly because the repo is on a VM (item H)
- if edits overlap each other, we should have an option to show a single edit at a time
- ~~panel doesn't show the number of files like Problems or Ports do~~ done 2026-09-22
