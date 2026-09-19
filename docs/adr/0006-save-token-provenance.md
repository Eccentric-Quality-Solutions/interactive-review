# ADR-0006 — Discriminate user saves from external writes by save-event provenance

**Date:** 2026-07-12 · **Status:** Accepted · **Supersedes** the inherited buffer-match heuristic
· **Amended by [ADR-0013](0013-bom-insensitive-comparison.md)** (2026-08-17): the content
comparison is BOM-insensitive; the "exact content matching" consequence below is narrowed
accordingly.

## Context

The product property: a change you make **by hand in the editor and save** is silently
adopted into the baseline and never enters the review queue; a change written **to disk
out-of-band** — an agent, a script, a formatter — is surfaced for review. The queue stays
focused on the agent's turn, not your own in-flight edits.

VS Code exposes **no API for edit authorship**. `onDidChangeTextDocument` fires identically
for user typing and for an extension's `WorkspaceEdit`. `TextDocumentChangeReason`
([vscode#120617](https://github.com/microsoft/vscode/issues/120617)) is **closed** — the
`userInput` value was deliberately dropped, shipping only `Undo`/`Redo` — and a maintainer has
confirmed no source signal is offered
([vscode-discussions#1157](https://github.com/microsoft/vscode-discussions/discussions/1157)).
The gap is settled, not pending. So a heuristic is required.

The inherited heuristic compared buffer text to disk text (`openDoc.getText() === diskContent`).
It is **unfixable in principle**: VS Code silently reloads a saved/clean open document when
its file changes on disk (the reload prompt appears only for *dirty* buffers, and a request to
extend it to clean files, [vscode#50472](https://github.com/microsoft/vscode/issues/50472), was
closed without change). So a human's Ctrl+S and an agent's write to a clean open buffer are
**indistinguishable by content** — in both, buffer == disk. The heuristic raced VS Code's
reload against its own read of the buffer, with no ordering guarantee, and lost often enough
to silently swallow agent edits.

## Decision

Key off **event provenance**, content-anchored. `onDidSaveTextDocument` records
`path → savedText`; `consumeManualSave(path, diskContent)` consumes that token once and
absorbs into the baseline **only if** the saved text exactly equals what is now on disk.
Anything else falls through to review. The buffer comparison is **deleted**, not kept as a
fallback.

## Consequences

- `onDidSaveTextDocument` fires for every VS Code-initiated save — explicit *and* every
  auto-save mode, which all route through `TextFileService.save()` — and **never** for an
  external write. It is a positive, unambiguous signal.
- Exact content matching is deliberate: it **fails safe toward reviewing**. A stale token (a
  save whose disk event never arrived) can only ever match no-op content; it cannot swallow a
  real external edit. Event ordering and buffer reloads are both irrelevant to the outcome.
- Stranded tokens are additionally reclaimed by construction (`b236a6f`): tokens are tracked
  by object identity and dropped in a `finally` around the disk handlers, so a handler that
  early-returns cannot leave one behind.
- Distinct from the `selfEditFiles` guard, which suppresses the extension's *own* accept/reject
  writes.
- **Not covered:** an atomic rename-into-place create (write temp + `rename()`, landing as
  DELETE+CREATE) has no matching saved buffer, so it defaults to reviewing — correct, but by
  fallthrough rather than by signal.

## References

[terminal-edits-not-captured.md](../terminal-edits-not-captured.md) — the diagnosis and what
shipped · [design.md §4f](../design.md) — the product property ·
`src/test/integration/saveVsExternalEdit.test.ts`.
