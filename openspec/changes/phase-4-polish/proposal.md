## Why

The review flow now walks a bounded changeset to closure (Phases 2–3), but it is
still **mouse-bound and coarse**: accept/reject exist only as webview and CodeLens
clicks, there is no keyboard path through the queue, and a hunk can only be taken or
dropped whole. The interactive-review model promises accept and reject as *equally
cheap, one-gesture* actions and a walk you can drive without leaving the keyboard.
This change is the "polish" phase that makes the flow feel finished, plus it settles
the two remaining open design decisions (trigger UX naming; the in-file surface).

## What Changes

- **Keyboard-drive the walk.** Register real commands (currently accept/reject are
  webview-message-only) and default keybindings for: accept hunk, reject hunk, next
  hunk, previous hunk, accept file, reject file. Accept and reject get identical
  affordance weight and both are one-gesture, one-undo (accept/reject **symmetry**).
- **Partial-hunk actions.** Allow accepting or rejecting a *selected line range* inside
  a hunk, so a messy hunk mixing wanted and unwanted edits can be split rather than
  forced whole.
- **Optional in-file decorations surface.** Add a decorations-only review surface
  (added-line highlighting via `TextEditorDecorationType`, removed lines via peek) as
  an alternative to the native diff editor — resolving open decision §5 #3. Selectable
  via the existing `useDiffEditor` / `showInlineDecorations` settings.
- **Trigger UX.** Surface snapshot-on-command explicitly as **"Begin review"** /
  **"End review"** commands (today it is the ambiguously-named "Enable for this
  project"), plus an optional agent-callable command to open a review at a turn
  boundary — completing the §5 #2 decision without changing the underlying mechanics.

Non-goals (explicitly deferred, per Phase 2/3 scoping): no persistent per-hunk
disposition model, no `Changeset`/`FileEntry` types, no reactive-watcher hardening.

## Capabilities

### New Capabilities
- `review-keybindings`: command + keybinding surface for driving the review queue from
  the keyboard — accept/reject hunk, next/prev hunk, accept/reject file — with accept
  and reject as symmetric one-gesture, one-undo actions.
- `partial-hunk-actions`: accept or reject a selected line range within a hunk, for
  hunks that mix wanted and unwanted changes.
- `inline-decorations-surface`: an optional in-editor review surface using text
  decorations for added lines (removed lines shown via peek), as an alternative to the
  native diff editor; resolves the primary-surface decision (§5 #3).
- `review-trigger-ux`: snapshot-on-command trigger surfaced as explicit "Begin review"
  / "End review" commands plus an optional agent-callable hook, completing §5 #2.

### Modified Capabilities
<!-- None — no existing specs; the review mechanics remain unchanged, only surfaced. -->

## Impact

- **`package.json`** — new `contributes.commands`, `contributes.keybindings`, and
  editor/context-menu entries; command titles for Begin/End review.
- **`src/commands.ts`** — register palette commands wrapping existing accept/reject
  functions; add next/prev-hunk navigation and partial-range accept/reject.
- **`src/diffEngine.ts`** — line-range-scoped hunk resolution for partial actions.
- **`src/diffCodeLens.ts`** / new inline decorations module — the optional in-file
  surface; wire to `useDiffEditor` / `showInlineDecorations`.
- **`src/extension.ts`** / **`src/reviewPanel.ts`** — command wiring, Begin/End review
  naming, keybinding-driven advance reusing the existing walk/advance path.
- No changes to the baseline/git storage layer or the changeset state model.
