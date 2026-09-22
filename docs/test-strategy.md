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
   mutation for it to [`scripts/mutation-check.mjs`](../scripts/mutation-check.mjs), which
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
any of them, check its mutation in `scripts/mutation-check.mjs`.

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
| Refresh keeps an unbaselined file unbaselined | `stateManagerGit.test.ts` | a file Discard kept becoming one it deletes |
| A window reload keeps it unbaselined too | `stateManagerGit.test.ts` | the same, after restarting VS Code |
| A branch switch forgets the saved record too | `stateManagerGit.test.ts` | a reload restoring what memory forgot |
| A rewritten hunk at the same position gets a new id | `diffEngine.test.ts` | a stale click accepting text the user never saw |
| Renaming onto a pending deletion or over a file: the source wins, and Discard keeps an unbaselined source | `reloadEqualsMemory.test.ts` + `stateManagerGit.test.ts` | memory and a reload disagreeing on the target |
| A Refresh leaves a correct queue unchanged | `reloadEqualsMemory.test.ts` (every `refresh` step) | a Refresh overwriting a wrong memory, hiding it from the reload check |
| A file unreadable at Begin review is never adopted as deletable | `stateManagerGit.test.ts` | the user's file becoming one Discard deletes after a Refresh or reload |
| Discarding an unbaselined file keeps it out of the queue | `reloadEqualsMemory.test.ts` + `deleteRestore.test.ts` (integration) | the file coming back on the next Refresh or reload |
| Discarding a hunk or rejecting lines of an unbaselined file keeps its content | `deleteRestore.test.ts` (integration) | the user's own file saved empty, or lines of it deleted |
| Discarding an unreadable unbaselined file drops it without throwing | `deleteRestore.test.ts` (integration) | an unhandled rejection from a CodeLens Discard, file left queued |
| Only a create is ever classified `'created'`; binaries are never adopted | `diskEvent.test.ts` (every input) | a change making the user's file one Discard deletes |
| Hunk accept refuses a buffer with unsaved edits | `reviewCommands.test.ts` (integration) | unsaved text in the baseline, file queued again on reload (`todo.md` item D) |
| A file that has left review diffs against its baseline | `diffEditor.test.ts` (integration) | a re-fetched diff painting the whole file as added |

The nine integration guards are not in the mutation script; they were verified by hand.

**Limits of the reload property.** [`reloadEqualsMemory.test.ts`](../src/test/reloadEqualsMemory.test.ts)
mirrors `FileWatcher` and `commands.ts` at the StateManager boundary, so a change to either
needs its mirror updated. The exception is what a create or change event decides: that is
the real `classifyDiskEvent`, and the mirror copies only the reads around it. It cannot reach defects in which text the command layer passes
(such as `todo.md` item D, dirty-buffer accept), because that layer is not modelled, and
a defect in `commands.ts` that the mirror copies faithfully passes it. Such a fix needs an
integration test as well, as the Discard fix below has.

Its `'unbaselined'` entries come only from a `missed-create` step, a create delivered as a
change alone. The other source, a file unreadable at Begin review, needs `chmod` in the
setup and is covered in `stateManagerGit.test.ts` instead. Neither the step nor a `refresh`
step existed until 2026-09-21; adding them found the Discard defect on the first sweep.

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
- **What a rebuild throws away, it must remember elsewhere.** Refresh re-derives state
  from disk and git, which cannot tell a new file from one never baselined. The session's
  own classification has to survive in a set beside the state, in both directions:
  `sessionCreated` so agent output stays deletable, `sessionUnbaselined` so the user's
  files do not become deletable.
- **A rescan can hide the bug it should reveal.** A Refresh rebuilds memory from git, so
  a Refresh between a defect and the next reload check makes memory and git agree again.
  The `refresh` step therefore asserts that a Refresh changes nothing, rather than relying
  on the reload check after it.
- **If nothing can be restored, Discard means Accept.** Discard on an unbaselined file keeps
  the bytes, which is what Accept does, and it has to record that the same way, with a
  blob. Dropping only the entry leaves nothing a rescan can read. The same holds for every
  discard path: hunk-level Discard treated the missing baseline as `''` and saved the
  user's file empty. A null baseline is "unknown", never "empty".
- **A partial operation may increase the hunk count.** Accepting a line from the middle of
  a replace hunk legitimately splits it. Assert on pending work instead: additions drop by
  at least the number selected, removals never rise. Recorded so nobody re-proposes the
  false invariant.

## Waiting in integration tests

- **Before a positive assertion, wait on the condition.** A sleep there fails when the
  machine is slow, and CI says so. About 80 remain; convert one when it flakes or when its
  test is edited anyway, not in a sweep. The brand-new-external-file tests use
  `waitForWatcher`, a plain wait, not `waitForConditionNudged`; keep it that way.
- **Before a negative assertion ("not queued", "not tracked"), call `settle()`** from the
  integration helpers. A sleep there passes when the event is late, so it can pass on
  broken code. `settle()` waits on `FileWatcher.whenIdle()`: no handler queued or running,
  no debounce pending, baseline writes drained.
- **When the negative is about a disk event, use `settle({ canary: true })`.** `whenIdle()`
  cannot see an event the OS has not delivered yet, and on an inotify-starved machine
  "idle" often means exactly that. The canary is a file the watcher must queue, written
  after the one under test. Once it is queued, the earlier events have arrived. This
  assumes the watcher reports events in order, which is inotify's behaviour; the
  assertion is "a later thing happened, and the earlier thing still did not".

## Open design questions

- **Extract `planAccept`/`planDiscard`** as pure functions, the way `hunkApply` and
  `classifyDiskEvent` were. Do it when next working in the command layer, not on its own:
  the reload property already covers their decisions through its mirror.

Closed 2026-09-21: the baseline provider now answers a file with no state with its recorded
baseline rather than `''`, so the whole-file flash no longer depends on VS Code's cache; and
`classifyDiskEvent` holds the watcher's decision about new files.

## Deliberately not building

- **Pixel or screenshot tests of the diff editor.** The lens-geometry property catches the
  real defect; screenshots would be slow and flaky.
- **More VS Code mocking to unit-test the command layer.** A mocked `TextDocument` mirrors
  the implementation. Move arithmetic out into pure modules instead.
- **Coverage targets.** Every defect above sat on lines that were already executed. What
  was missing was an assertion about composition.
- **A test for the whole-file flash timing.** It is a repaint artifact over a few hundred
  milliseconds, and the provider fix removed its cause; the provider has its own test.
- **Tests for `media/panel.js`**, until it grows logic beyond rendering.

## The integration suite on this machine

The file-watcher integration tests flake here, and the pattern is diagnostic. Across
repeated runs of identical code, *which* tests fail changes from run to run, and some runs
pass all eleven. A deterministic regression fails the same tests every time. The cause is
inotify starvation: this workstation runs at roughly 121 of 128 inotify instances. See the
`integration-suite-inotify` note and `todo.md` item 4.

The watcher tests are honest, so they flake here *more* than dishonest ones would. On
2026-09-21, at 129–130 instances against the 128 limit, runs of identical code passed 11/11
and then failed 3–4, with a different set each time. For every failing test, the extension
log showed no create or change event for its file at all. The same day, the first CI run on
a pull request passed every watcher test on a runner with raised limits.

**CI settles it.** A watcher failure that reproduces on the pull request's integration job
is a real bug. One that fails only here, and fails a different test on the next run, is
starvation. Never call a failure environmental without that evidence.

The first CI run did find one real test defect: a fixed 300 ms sleep before an assertion,
which the runner took 1.8 s to satisfy. That is the fixed-sleep problem under "Waiting in
integration tests", failing loudly instead of silently.
