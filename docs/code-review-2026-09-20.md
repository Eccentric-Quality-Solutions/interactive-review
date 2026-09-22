# Open findings — full-codebase review, 2026-09-20

Reviewed at `06699a9`, across all 15 source modules plus `media/panel.js`. Findings already
tracked in [`../todo.md`](../todo.md) are **excluded** — everything below was new at the
time of writing.

**This file lists only what is still open.** Ten findings from the same review were fixed
on 2026-09-20 and have been removed from it: the end-of-file splice defects in accept and
discard (now [`hunkApply.ts`](../src/hunkApply.ts), with a property test replacing the
argument), unbounded `git hash-object` fan-out during the enable snapshot, git pathspec and
global-config hardening, directory deletes that removed nothing from the index, re-entering
an open review session, and three UI-level items. §1.1, the rename guards, was resolved on
2026-09-21 when the disk-event handlers started reading baselines through
`StateManager.readBaseline`, which waits for queued writes such as the rename. §1.2, the
`nullReason` contradiction, was resolved the same day: a Refresh now keeps the session's
own classification instead of re-adopting every untracked file as `'created'`. See the git
history for those. The remaining sections keep their original numbers.

§1.3 and §2.1 were closed on 2026-09-22 as out of scope: the README now states that
multi-root workspaces and Windows are not supported. §5 records a verification pass over
the fixed items on the same day.

Ordered by what a defect would cost the user, not by how interesting it is.

---

## 1. Unresolved correctness

No open items. §1.3 (multi-root) was closed as out of scope; see above.

---

## 2. Lower severity

| # | Finding | Note |
|---|---|---|
| 2.2 | **Baselines over 10 MB read back as missing.** `maxBuffer` caps `git show`, but `hash-object` has no cap, so a large text file snapshots fine and then reviews as unbaselined. | |
| 2.3 | **`shouldIgnore` recompiles the user pattern matcher on every call**, and `collectGitignores` descends into `.git` and unignored `node_modules` synchronously on every gitignore event. | Performance only |
| 2.4 | **Save tokens for files under `files.watcherExclude` never release**, since no watcher event arrives. Each retains the file's full text for the session. | |
| 2.5 | **An externally deleted directory's tracked-but-idle children are never surfaced.** The child sweep iterates in-memory state only, so their deletions are silently lost from review. | Behaviour change, see §3 |

---

## 3. Caveats on the above

- **§2.5 is a behaviour change, not a repair.** Surfacing those deletions means a
  `listTrackedFiles` call and a `getBaseline` per child on every directory-delete event.
  That cost needs a decision before it is paid.

---

## 4. The structural note

Kept because it is the reason the fixed items were fixed the way they were.

This codebase uses comments where it should use tests. The proof came from the review
itself. `discardHunk` re-added a newline to files that had none, so the file could never
leave review — and there *was* a passing unit test for `computeHunks` on content without a
trailing newline. The suite tested the part; the bug lived in the composition.

The sharper proof came an hour later. The review had explicitly cleared `acceptHunk` of the
same defect, with a plausible written argument about why array splicing was safe. The
property harness built to fix `discardHunk` disproved that argument on its fifth generated
input: `split('\n')` returns one element more than jsdiff counts lines, and the stranded
empty element re-terminated the file. A careful reading of code, by someone who had just
found the identical bug next door, missed it.

The prose in this repo is often excellent and worth keeping; the BOM and save-token essays
are real institutional memory about real bugs. The failure mode is narrower than "too many
comments": it is *an invariant given a twenty-line argument for why it holds, instead of an
assertion that it holds*. §1.2 was the same shape, in the one mechanism where being wrong
deletes a file: two comments, each arguing its own side, and no test where they met.

The counter-move is already in the tree. One generator over random baseline/edit pairs
covers the trailing-newline case, the BOM cases, the EOL cases and the partial-selection
splices at once, and fails loudly when any of them stops being true. §1.2 was closed the same way, with
tests in `stateManagerGit.test.ts` and a mutation that re-introduces the defect.

---

## 5. Verification of the fixed items, 2026-09-22

Every fix listed at the top was checked against the code at `b372bf4`, by reading it and by
running probes against scratch repos. Each fix closes the defect it was aimed at. The gaps
below sit next to those fixes rather than inside them.

### 5.1 Fixed the same day

- **A rescan answered `'created'` for any file with no record.** This extends §1.2. The fix
  there kept the session's own classification, but a file with *no* record still defaulted
  to the value that lets Discard delete it. Review found four ways to lose the record:
  - a file ignored at Begin review and no longer ignored by the next reload
  - the children of a renamed directory
  - a filename git prints C-quoted (§5.2)
  - a damaged record file

  The default is now `'unbaselined'`. Only a saved witness of the create answers
  `'created'`, and `sessionCreated` is saved beside the baseline repo so a reload keeps
  agent output deletable. The cost runs the safe way: a new file whose witness was lost is
  kept on Discard. The `readBatch` record of unreadable files became redundant and was
  removed.
- **A failed Begin review could not be retried.** `setEnabled(true)` left `enabled` set
  after a snapshot failure. An agent's retry then hit the "already open" guard and
  *resolved*, so the agent went on editing over a repo with no baselines. The failure path
  now tears the session down; see `beginReview.test.ts`.

Both have tests, and both have entries in `scripts/mutation-check.mjs`.

### 5.2 Open, fix when touched

| # | Finding | Cost now |
|---|---|---|
| 5.2.1 | **`ls-files` and `ls-tree` run without `-z`.** Names containing `"`, `\`, a tab or a newline come back C-quoted: `core.quotepath=false` only covers bytes ≥ 0x80. Those files are skipped on load, missed by `renameFile` and missed by a directory delete. | Since §5.1 they are no longer deletable. Renames and deletes of such files still misbehave. |
| 5.2.2 | **Git inherits the user's environment and config.** Only `commit.gpgsign` and `core.hooksPath` are pinned. Clean filters from global config run on every commit, and a `required` filter such as Git LFS's fails Begin review outright. `core.fsmonitor` runs too. An inherited `GIT_INDEX_FILE` (or `GIT_OBJECT_DIRECTORY`, and the like) redirects the baseline repo. Fix: strip `GIT_*` from the environment, set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, and pin a commit identity. | Only if you use LFS, or VS Code is launched from inside a git hook. |
| 5.2.3 | **Discard across line endings can take two passes.** With a CRLF baseline and an LF document, `discardHunkText` inserts baseline lines with their `\r`. VS Code converts the lone `\r` into a line break, leaving a blank-line hunk behind. Every case the probe generated converged. Fix: insert the document's EOL. | Cosmetic. |
| 5.2.4 | **The property generator never produces an empty or 11-line baseline.** The LCG's first draw is nearly linear in the seed, so `randomLines(rnd, 12)` yields 2–9 lines for seeds 1–1500. An exhaustive probe found the code correct there, so the defect is in the tests, not the code. Also: the `'inner\rcarriage return'` word models a document state VS Code cannot hold. | Test coverage only. |
| 5.2.5 | **`readBatch` reads every workspace file at once.** On hosts with a low open-file limit the excess fails with EMFILE, and those files are silently left unbaselined. | Only on large workspaces with a low `ulimit -n`. |
| 5.2.6 | **Some failures are only logged.** A failed branch-switch snapshot has already cleared review state. A failed `syncIgnoreState` makes a Refresh report success. `removeFileBatch` never re-throws. | Silent. It loses no user content, but the review state goes stale. |

### 5.3 Open, deferred

- **A rename racing a handler already in flight.** `renameFile` does not go through
  `PathSerializer`. A change handler that has read the old path can resume after the rename
  and write a phantom "deleted" entry for it. Discarding that entry writes a duplicate of
  the renamed file. The window is one `git cat-file` wide. The fix (run `renameFile` under
  `perPath` for both paths) needs a test that forces the interleaving, or it is one more
  argument in prose.
- **End review during Begin review's snapshot** makes Begin reject with a message telling
  the user to retry a session they have just ended. The message misleads, and nothing is
  damaged.
