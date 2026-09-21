# ADR-0004 — Snapshot-on-command is the trigger; the file watcher is a secondary signal

**Date:** 2026-07-05 · **Status:** Accepted

## Context

hunkwise's model is an always-on reactive file watcher: every external write to any file
enters review, forever, with no turn boundary and therefore no completion state. Our target —
the [interactive review model](../interactive-review-model.md) — is a *bounded* changeset
walked to closure.

Separately, the Phase-1 integration triage raised doubt about whether
`vscode.workspace.createFileSystemWatcher` reliably delivers external create/delete events on
Linux. (That doubt was later **retracted**: a purpose-built probe on an unsaturated host
delivered 30/30 events at ~130ms. What was actually being measured was inotify starvation on
a busy dev workstation, not a platform limit.)

## Decision

**"Begin review" explicitly snapshots the baseline now and bounds the changeset**, using the
synchronous `snapshotWorkspace` path. The reactive watcher is demoted to a *secondary* signal
that updates an already-open changeset when it fires; it is not the trigger.

## Consequences

- Completion becomes definable: the reviewing set is bounded at snapshot time, so
  "review complete" is a state the tool can reach.
- The tool-agnostic property is kept — `interactiveReview.beginReview` is a plain command, not
  an integration with any one agent, and it is deliberately **non-interactive** (dialog-free,
  panel-independent, resolves only once the snapshot is durable) so an agent can invoke it at
  a turn boundary. That contract is recorded as a comment on `enableReview` and pinned by
  `triggerUx.test.ts`.
- **No production polling fallback was ever built** for the watcher, since it is off the
  critical path. The retraction of the Linux-watcher finding strengthens rather than weakens
  this: the watcher works.
- An agent-callable hook marking turn boundaries more richly stays possible as an additive
  enhancement; it is not v1-required.

## References

[design.md §4c.1, §5 #2](../design.md) ·
[interactive-review-model.md](../interactive-review-model.md) ·
`src/test/integration/watcherProbe.test.ts` (run with `WATCHER_PROBE=1`).
