# ADR-0001 — Stable VS Code APIs only; no `editorInsets`

**Date:** 2026-07-04 · **Status:** Accepted

## Context

The review experience we want — a floating Accept/Discard bar and a rendered deleted-lines
block *inside the normal editor buffer* — has exactly one mechanism in VS Code:
`editorInsets` (`createWebviewTextEditorInset`, VS Code issue #85682). It has been **proposed
since 2019** and never stabilized. Declaring it means: no Marketplace publish, installation
via Insiders or an `argv.json` opt-in, known flakiness on some Linux stable builds, and
breakage risk on every VS Code release.

The alternative path — CodeLens in the native diff editor, against a virtual baseline
document served by a `TextDocumentContentProvider` — is entirely stable, and is proven by
hunkwise's own second rendering path as well as by Continue and Cline shipping on the
Marketplace with no proposed API.

## Decision

Build on **stable APIs only**. `editorInsets` is deferred to a possible future "enhanced
inline mode," not a dependency.

## Consequences

- The extension is a normal Marketplace-shippable install: no Insiders, no `argv.json`, no
  Linux friction.
- We forgo the floating in-buffer button bar and the in-buffer deleted-lines block. This is a
  **UX-fidelity trade, not a capability loss** — every required feature (inline red/green,
  per-hunk accept/reject, per-range actions, auto-advance, multi-file) is reachable on stable
  APIs.
- The charter is load-bearing downstream: it forces [ADR-0003](0003-inline-diff-editor-sole-surface.md)
  (the diff editor becomes the surface, since decorations cannot show removed lines), and it
  is why `TextEditorDiffInformation` — the API that would let us read the diff VS Code
  actually painted — is unavailable to us while it remains proposed.

## References

[hunkwise-evaluation.md §3–§4, §8](../hunkwise-evaluation.md) · [design.md §4a](../design.md)
· fork commit `ec138e4` stripped the proposed API.
