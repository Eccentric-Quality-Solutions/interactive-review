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

Ordered by what a defect would cost the user, not by how interesting it is.

---

## 1. Unresolved correctness

### 1.3 Multi-root workspaces produce spurious entries

**May be out of scope** — see §3.

The watcher glob covers every workspace folder, but `StateManager` and `shouldIgnore` only
know folder zero. A file in a second folder yields a relative path like `../other/x`, so
`getBaseline` fails, the file enters review as `created`, and any snapshot attempt errors
in git. Nothing filters events down to the known root.

---

## 2. Lower severity

| # | Finding | Note |
|---|---|---|
| 2.1 | **Windows path separators reach git.** `path.relative` yields backslashes, and `renameFile` compares them against forward-slash `ls-files` output, so nested directory renames compute a wrong suffix. | Scope decision, same as §1.3 |
| 2.2 | **Baselines over 10 MB read back as missing.** `maxBuffer` caps `git show`, but `hash-object` has no cap, so a large text file snapshots fine and then reviews as unbaselined. | |
| 2.3 | **`shouldIgnore` recompiles the user pattern matcher on every call**, and `collectGitignores` descends into `.git` and unignored `node_modules` synchronously on every gitignore event. | Performance only |
| 2.4 | **Save tokens for files under `files.watcherExclude` never release**, since no watcher event arrives. Each retains the file's full text for the session. | |
| 2.5 | **An externally deleted directory's tracked-but-idle children are never surfaced.** The child sweep iterates in-memory state only, so their deletions are silently lost from review. | Behaviour change, see §3 |

---

## 3. Caveats on the above

- **§1.3 and §2.1 may simply be out of scope.** If multi-root and Windows are not
  supported, the correct fix is a line in the README, not code.
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
