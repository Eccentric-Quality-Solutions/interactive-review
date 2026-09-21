# Test strategy

Decided 2026-09-20, after the project kept shipping regressions. Two independent reviews
were run in parallel against the same facts and the same regression history — one from a
pragmatic engineer weighing protection per hour, one from a test-suite engineer on
architecture and testability — without being shown a proposed plan, so neither was
anchored on it. This document is the synthesis and the standing policy; what is still
open is listed near the end.

## The diagnosis

Both reviews reached the same core finding independently, and it was checked against the
tree before anything was decided:

- **Fixes were landing without tests.** Every fix shipped on 2026-09-20 could be reverted
  with the suite staying green. The suite was not missing a *layer*; it was missing the
  habit.
- **Some existing tests could not fail.** The Begin-twice test asserted a baseline survived
  a second Begin review, but never changed the file between the two, so the broken code
  passed it too. Five watcher tests drive a Refresh on every poll, so they test the rescan
  and would stay green if watcher delivery broke entirely.
- **Invariants were argued in comments instead of asserted in tests.** Several defects sat
  beneath a well-reasoned comment claiming the property the code lacked.

The regression history clusters into two recurring classes, which is what makes a small
test investment go a long way:

1. **Splice and diff composition** — accept, discard, partial selection, lens placement,
   BOM, CRLF, end-of-file newlines. Pure logic, testable at unit speed.
2. **The baseline repo drifting from reality** — git's leniency, the user's git config,
   directory removal, file-descriptor limits, swallowed errors. Testable against real git
   in a temp directory, also at unit speed.

## The rules

1. **A fix lands with a test that fails on the code before it.** Proven, not assumed: add a
   mutation for it to [`scripts/mutation-check.py`](../scripts/mutation-check.py), which
   re-introduces each defect and requires the guarding test to fail. A regression test that
   passes on broken code is worse than none — it manufactures confidence.
2. **A comment that asserts an invariant names the test that fails if it is false.** If
   there is no such test, write one or cut the claim.
3. **Prefer a property to an example** for anything with arithmetic in it. Pin every failure
   a property finds as a named example as well, so it survives a generator change.

```sh
npm test                  # unit + property + real-git contract tests, ~5s
npm run test:mutation     # proves each regression test catches its bug, ~1 min
npm run test:integration  # real VS Code, ~4 min — see the flakiness note below

# The reload-equals-memory property at depth (~3 min). Run it after touching StateManager,
# FileWatcher or the commands; CI runs it at 200 seeds on every push.
RELOAD_SEEDS=400 RELOAD_STEPS=25 node --test out-test/test/reloadEqualsMemory.test.js
```

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs the unit suite, the
mutation check and the deep sweep on every push, and the integration suite under `xvfb-run`
on pull requests, on a runner with raised inotify limits.

**Build stamp.** To answer "is the installed build the one I tested?", `npm run compile`
writes `out/buildInfo.json` (version, commit, dirty flag, build time) via
[`scripts/build-stamp.js`](../scripts/build-stamp.js). It is logged on activation and shown
in small print on the panel's splash and settings screens. `vsce package` refuses a tree
with uncommitted changes to build inputs; `IR_ALLOW_DIRTY=1` overrides that for a
deliberate local install, and the stamp then says `-dirty`.

## Existing regression guards

Each of these guards a defect that shipped at least once. Before deleting or "simplifying"
any of them, check its mutation in `scripts/mutation-check.py`.

| Guard | Where | Catches |
|---|---|---|
| Filenames are literal, never git globs | `baselineGitHardening.test.ts` | rename rewrote another file's baseline |
| Untracked glob-named path reads as undefined | `baselineGitHardening.test.ts` | untracked `x[1].txt` read as tracked |
| Root file named `1:x` reads its baseline | `baselineGitHardening.test.ts` | `:<n>:<rest>` parsed as a stage number |
| User's `commit.gpgsign` / `core.hooksPath` | `baselineGitHardening.test.ts` | every snapshot failing |
| Snapshot under `ulimit -n 256` | `baselineGitHardening.test.ts` | EMFILE → silently empty baseline |
| `removeFile(<dir>)` is a git no-op | `baselineGitHardening.test.ts` | characterisation, stops a "simplification" |
| Directory delete removes all children | `stateManagerGit.test.ts` | phantom deletions after reload |
| A failed snapshot reaches its callers | `stateManagerGit.test.ts` | contradictory notifications, false success |
| Lens anchor lies inside its own hunk | `diffEngine.test.ts` | Accept resolved the neighbouring hunk |
| Accept/discard: progress, convergence, exact result | `hunkApply.test.ts` | end-of-file splice defects |
| Interleaved accept + discard converges | `hunkApply.test.ts` | composition neither alone exercises |
| Partial accept/reject resolve ≥ k additions, add no removal | `hunkApply.test.ts` | end-of-file partial ops growing the change |
| Begin review twice keeps pending review | `triggerUx.test.ts` (integration) | baseline overwritten by a second Begin |
| Explorer folder delete, then Refresh | `rename.test.ts` (integration) | the watcher wiring, where the bug lived |
| Concurrent Begin waits for the one in flight | `triggerUx.test.ts` (integration) | resolving before any baseline exists |
| A fresh `load()` reproduces the live queue | `reloadEqualsMemory.test.ts` | the whole phantom-after-reload family |
| Delete straight after an accept | `reloadEqualsMemory.test.ts` | deletion shown against pre-accept text |
| Recreate straight after an Explorer folder delete | `reloadEqualsMemory.test.ts` | stale baseline read for a new file |
| End review straight after an accept | `reloadEqualsMemory.test.ts` | rollback into an ended session, false error |
| FileWatcher never calls `getBaseline` directly | `reloadEqualsMemory.test.ts` | a handler bypassing `readBaseline` |
| External create is classified `'created'` | `filewatch.test.ts` (integration) | test passing with create delivery off |
| Begin review during End review's drain | `stateManagerGit.test.ts` | End deleting the new session's repo |
| Handlers for one path run in arrival order | `pathSerializer.test.ts` + source scan | a change overwriting a create's `'created'` |
| Session re-checked after every baseline read | `reloadEqualsMemory.test.ts` (source scan) | a phantom entry written after End review |

The four integration guards are not in the mutation script; they were verified by hand.

**Limits of the reload property.** [`reloadEqualsMemory.test.ts`](../src/test/reloadEqualsMemory.test.ts)
mirrors `FileWatcher` and `commands.ts` at the StateManager boundary, so a change to either
needs its mirror updated. It cannot reach defects in which text the command layer passes
(such as `todo.md` item D, dirty-buffer accept), because that layer is not modelled.

The property generators live in [`src/test/generators.ts`](../src/test/generators.ts) and
cover the shapes that have actually broken: independent line endings and final newlines per
side, BOM, empty and single-line text, long lines, non-ASCII, and a `\r` inside a line. Keep
new generators at least that adversarial.

## Lessons from the defects

- **Git's path arguments are not literal.** Anything with glob characters is a pathspec,
  and `:<path>` is ambiguous twice over: `git show :x[1].txt` exits 0 for an untracked file,
  and `:1:notes.txt` means stage 1 of `notes.txt`. Read blobs with `git cat-file blob
  :0:<path>` and test with hostile filenames.
- **Fixes regress too.** Of the defects found on 2026-09-20, several were introduced by that
  same day's fixes — including one found only by code review, beneath a comment claiming the
  fix "can never reinterpret the argument". That is why rule 2 exists.
- **A failure must reach the caller.** A snapshot that showed an error and returned normally
  let its caller announce success beside it. Throw, and let each caller say what it means.
- **Guards set synchronously before an await also fire for the operation in flight.**
  A second concurrent Begin review must join the first, not resolve early.
- **End of file is where splices break.** The missing final newline belongs to whichever
  line is last, and partial accept/reject there broke in both directions.
- **Read a baseline after the writes queued ahead of it.** Writes to the baseline repo are
  queued; a direct `getBaseline` is not. Three of the four defects the reload property found
  on its first run were one handler reading a baseline that a queued write was about to
  replace. Handlers read through `StateManager.readBaseline`, which drains the queue first,
  and teardown drains before it destroys.
- **Fixing one wait can open another window.** Draining the queue before End review's
  teardown let a Begin review land mid-teardown and lose its repo. The first fix was found by
  a property test and the second by code review. Any new `await` in a lifecycle path needs
  the question "what can run in this gap?"
- **Handlers that read, await, then write need an order and a session.** Disk-event handlers
  for one path now run in arrival order (`PathSerializer`). Each samples the session when its
  event arrives and drops its write if the session has changed by the time it writes.
- **A test of the watcher must be able to fail without it.** Removing the Refresh nudge was
  not enough for the plain create test: the same write fires a change event, which queues
  the file too. Only `nullReason: 'created'` proves the create handler ran. The check is to
  switch the handler off and watch the test fail.
- **A partial operation may increase the hunk count.** Accepting a line from the middle of
  a replace hunk legitimately splits it. Assert on pending work instead: additions drop by
  at least the number selected, removals never rise. Recorded so nobody re-proposes the
  false invariant.

## Open test work

- **A `whenIdle()` test hook** for the watcher, so integration tests wait for the extension
  to settle rather than polling. The brand-new-external-file tests use `waitForWatcher`, a
  plain wait, not `waitForConditionNudged`; keep it that way.
- **Replace fixed sleeps before negative assertions** ("not queued") with waits on events.

## Open design questions

Real, but each is a design change rather than a test, so none is started.

- **Content-hash hunk ids.** Ids are positional. The stale-click warning added on
  2026-09-20 catches an id that no longer resolves, but not one that now happens to match a
  *different* hunk's coordinates, which would act on the wrong hunk.
- **Make the whole-file-flash fix independent of VS Code's cache.** The content provider
  still returns `''` for a file with no state; the fix works by not invalidating the cache.
  Any re-fetch of the baseline document, such as reopening the tab, would still paint the
  whole file as added. Remembering the last baseline served would remove the dependency.
- **Extract `classifyDiskEvent` and `planAccept`/`planDiscard`** as pure functions, the way
  `hunkApply` was extracted. The first also closes `todo.md` item 1 — three separate answers
  to "is this file new".
- **Renaming onto a pending deletion.** An unedited file renamed onto a path whose deletion
  is still in review: git gives the path the source's baseline, memory keeps the deletion,
  and a reload disagrees. Either the pending deletion silently leaves review (source wins),
  or the moved file is reviewed as an edit of the deleted one (target wins). Pinned as a
  `todo` in `reloadEqualsMemory.test.ts`. The generator avoids the case until it is decided.
- **The `nullReason` contradiction** in [code-review-2026-09-20.md](code-review-2026-09-20.md)
  §1.2, which is a product decision about how much Discard may delete.

## Deliberately not building

- **Pixel or screenshot tests of the diff editor.** The lens-geometry property catches the
  real defect; screenshots would be slow and flaky.
- **More VS Code mocking to unit-test the command layer.** A mocked `TextDocument` mirrors
  the implementation. Move arithmetic out into pure modules instead.
- **Coverage targets.** Every defect above sat on lines that were already executed. What
  was missing was an assertion about composition.
- **A test for the whole-file flash timing.** It is a repaint artifact over a few hundred
  milliseconds. The cache-independence fix above is the better investment.
- **Tests for `media/panel.js`**, until it grows logic beyond rendering.

## The integration suite on this machine

The file-watcher integration tests flake here, and the pattern is diagnostic. Across
repeated runs of identical code, *which* tests fail changes from run to run, and some runs
pass all eleven. A deterministic regression fails the same tests every time. The cause is
inotify starvation: this workstation runs at roughly 121 of 128 inotify instances. See the
`integration-suite-inotify` note and `todo.md` item 4.

The watcher tests are now honest, so they flake here *more* than before. On 2026-09-21, at
129–130 instances against the 128 limit, runs of identical code passed 11/11 and then failed
3–4, with a different set each time. For every failing test, the extension log showed no
create or change event for its file at all. Until CI has run on a pull request, treat a
watcher failure as environmental **only if** it fails to reproduce
in isolation and a different test fails on the next run. Never treat it as environmental
merely because it is inconvenient.
