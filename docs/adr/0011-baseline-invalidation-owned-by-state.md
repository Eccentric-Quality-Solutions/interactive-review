# ADR-0011 — Baseline invalidation is owned by state, not by commands

**Date:** 2026-08-11 · **Status:** Accepted

## Context

A report that after accepting a file to completion, letting the agent edit it again, and
reopening the diff, the editor painted the **whole file** as changed — while the review queue,
reading the same data, correctly listed one hunk. Two surfaces disagreeing about one fact is
the diagnostic: they were not reading the same copy of it.

The baseline has two representations. `StateManager`'s map is the authority; the diff editor's
original side is a virtual document served from that map by a `TextDocumentContentProvider` in
`extension.ts`, and VS Code caches that document until fired at. Only an invalidation event
keeps the two equal.

That event hung off the **accept commands**, which got the ordering backwards on the one path
that matters. A final accept runs `exitReviewing` — entry deleted — and *then* notified, so the
provider re-ran against an absent entry and cached `''`. Re-entering reviewing after the next
edit wrote a fresh baseline into the map and notified nobody, so the next `vscode.diff` was
served the empty cache. Original side empty, modified side the whole file: every line reads as
added.

Rejecting to completion reached the same state and never notified at all. `renameFile` and the
git-failure rollbacks also moved baselines silently. The command-level notification covered one
of five writers.

## Decision

**`StateManager` owns the notification.** It exposes `onDidChangeBaseline`, and every mutation
of `this.state` routes through three private writers — `writeState`, `dropState`, `clearState`
— which fire it. They are the only `set`/`delete`/`clear` sites in the class; a bare
`this.state.set` anywhere else silently reintroduces the defect, which is now a greppable
condition rather than a reasoning one.

`writeState` fires when `!prior || prior.baseline !== state.baseline`. The `!prior` clause is
what was missing: an absent entry renders as `''`, so *acquiring* a baseline is a change even
with nothing to compare against. The equality guard keeps status-only churn from invalidating a
cache that is already correct.

**Corollary: watcher-driven exits sweep their stale tabs.** Firing on delete is what correctness
demands, and it exposed a second fault the old silence had been hiding. `recomputeHunks` calls
`exitReviewing` when the user undoes back to baseline; with the tab still open, the now-honest
empty baseline repaints the whole file as added. `FileWatcher` therefore takes an
`onFileLeftReview` callback wired to `closeStaleTabs`, giving its three exit sites the sweep the
command paths already had via `walkAfterResolve`.

Suppressing the delete-side fire would also have removed the symptom, and was rejected. It buys
correctness on the reported bug by restoring a writer that mutates the baseline and tells nobody
— trading the invariant for a bet that nothing needs the notification *today*, which is the
shape of the original defect. The old behaviour was not correct; it was two errors cancelling.

The callback takes **no path**: its consumer scans every tab group and closes whatever no longer
reviews, so a path would be decoration — and would invite one full scan per file in the
directory-delete loop. For the same reason the sweep is not driven off `onDidChangeBaseline` in
`extension.ts`, the tidier seam: `clearState` fires once per path, so a teardown with N files
would scan N times.

## Consequences

- `StateManager` is now disposable and registered in `context.subscriptions`. The unit-test
  vscode mock gained a minimal `EventEmitter`, since the emitter is constructed at field
  initialization — its listener errors propagate rather than being swallowed as the real API
  does, so a test that breaks a listener fails loudly.
- Five hand-wired `fireBaselineChange` calls in `extension.ts` collapse to one subscription.
  `ReviewPanel` keeps a `refreshBaselineDoc` hook fired immediately before every `vscode.diff`:
  one no-op fire, and the surface stays correct even if a future writer escapes the event.
- The fix was confirmed to bite by reverting it in place (`!prior ||` → `prior &&`): four of the
  eight tests in `src/test/stateManagerBaseline.test.ts` fail, including one replaying the
  reported accept → edit → reopen sequence verbatim.

## Not done

- **Not verified against the live symptom.** Unit-verified and read-verified only; no VSIX was
  built and installed on the test VM to retry the reported sequence.
- **The tab sweep has no test.** It is real-tab behaviour, so it belongs in the integration
  suite rather than the unit mocks.

## References

`src/test/stateManagerBaseline.test.ts` · [ADR-0003](0003-inline-diff-editor-sole-surface.md)
(the virtual-document surface this invalidates) ·
[terminal-edits-not-captured.md](../terminal-edits-not-captured.md).
