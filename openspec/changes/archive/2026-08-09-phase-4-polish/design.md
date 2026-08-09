## Context

Phases 2–3 delivered the bounded walk-to-closure flow. The accept/reject mechanics live
in `src/commands.ts` (`acceptHunk`, `discardHunk`, `acceptFileByPath`,
`discardFileByPath`, `acceptAllFiles`, `discardAllFiles`) but are reachable only via
webview messages (`reviewPanel.handleMessage`) and two CodeLens commands
(`interactiveReview.codeLens{Accept,Discard}Hunk`). Within-file (`revealNextHunk`) and
cross-file (`reviewPanel.advanceToNextFile`) advance already exist. Hunks are computed
live by `computeHunks(baseline, current)` with a positional `hunkId`; resolution is
destructive (accept folds the hunk into the baseline; reject rewrites the file back).
Phase 0 removed the `editorInsets`-based `decorationManager`, so any in-file surface must
use only stable APIs (`TextEditorDecorationType`, CodeLens, peek). Settings
`useDiffEditor` (default false) and `showInlineDecorations` (default true) already exist
but the decorations surface behind them was stripped.

## Goals / Non-Goals

**Goals:**
- Full keyboard control of the walk with accept/reject symmetry (one gesture, one undo).
- Sub-hunk (line-range) accept/reject for messy hunks.
- An optional stable-API in-file decorations surface, resolving §5 #3.
- Clear snapshot-on-command trigger naming ("Begin review" / "End review") + an
  agent-callable entry point, completing §5 #2.

**Non-Goals:**
- No persistent per-hunk disposition model or `Changeset`/`FileEntry` types (deferred).
- No change to baseline/git storage or the reviewing-set state model.
- No reactive-watcher hardening; no `editorInsets`/proposed APIs.

## Decisions

### 1. Commands wrap existing functions; keybindings gated by a context key
Register `interactiveReview.acceptHunk` / `rejectHunk` / `nextHunk` / `prevHunk` /
`acceptFile` / `rejectFile`, each resolving the target from the **active editor + cursor
position** (compute hunks for the doc, find the hunk containing the cursor) and calling
the existing `commands.ts` functions — no new resolution logic. Set a context key
`interactiveReview.inReview` (via `setContext`) true when the active editor is a
reviewing file; default keybindings use `when: "interactiveReview.inReview &&
editorTextFocus"` so keys stay inert elsewhere. *Alternative rejected:* binding directly
to CodeLens commands — they require the hunk id as an argument, which a keybinding cannot
supply; cursor-resolution is needed regardless.

Accept/reject **symmetry** is already structurally true (both go through
`WorkspaceEdit` / baseline update, both single-undo); Phase 4 only gives reject equal
command/keybinding standing and matching panel affordance weight.

### 2. Next/prev reuse the existing advance path
`nextHunk` moves the cursor to the next pending hunk in the active editor; when none
remain it calls the existing `advanceToNextFile`. `prevHunk` is the mirror. This keeps a
single advance implementation shared by CodeLens, keyboard, and cross-file walk.

### 3. Partial actions decompose a hunk to its added lines
`acceptSelection` / `rejectSelection` intersect the editor selection with the pending
hunk and apply the standard fold/revert to **only the added lines in range**. Rationale:
line-based diffs make "accept these specific lines" well-defined for added lines, but
"reject a single removed line" inside a mixed add/remove hunk is ambiguous. Scope v1 to
added-line ranges; a hunk that is pure removal is handled at hunk granularity (fall back
to whole-hunk reject). After applying, recompute hunks so counts/status/advance stay
correct — reusing the existing "remainingHunks === 0 → exitReviewing" branch.
*Alternative rejected:* a full per-line disposition model — over-scoped for polish and
conflicts with the destructive-resolution decision from Phase 2/3.

### 4. Inline decorations rebuilt on stable APIs
When `useDiffEditor === false && showInlineDecorations === true`, `openFile` opens the
normal editor and a new lightweight `InlineDecorations` module applies a
`TextEditorDecorationType` to pending added lines (refreshed on the existing
`onStateChanged` funnel and `onDidChangeTextDocument`). Removed lines are reachable via
the already-file-scheme `DiffCodeLensProvider`: add a "Show N removed lines" CodeLens
that opens a peek of the baseline slice. Per-hunk accept/reject stay the same CodeLens
commands, so parity across surfaces is automatic. *Alternative rejected:* reintroducing
`editorInsets` — explicitly out of scope (Phase 0 removed it; keeps v1 shippable).

### 5. Rename by title, keep command IDs stable
Change the `title` of `interactiveReview.enable` → "Begin review" and
`interactiveReview.disable` → "End review" in `package.json`, and update the panel setup
text — but keep the command **IDs** unchanged so existing keybindings, tests, and the
webview messages don't break. The agent-callable entry point is the same
`interactiveReview.enable` (aliased conceptually as begin-review), invocable via
`vscode.commands.executeCommand`; document it as the turn-boundary hook. *Alternative
rejected:* new `beginReview`/`endReview` IDs — churns tests and the panel wiring for a
cosmetic gain.

## Risks / Trade-offs

- **Partial-reject ambiguity in mixed hunks** → Scope v1 to added-line ranges; fall back
  to whole-hunk for pure-removal cases; document the limitation in the setting/help.
- **Inline decorations show removed content worse than the diff editor** → Keep the diff
  editor the default/robust surface; decorations are opt-in; removed lines via peek.
- **Keybinding conflicts with user/other-extension bindings** → Gate every binding with
  the `interactiveReview.inReview` context key; choose defaults that avoid common editor
  chords; all are user-rebindable.
- **Cursor-based hunk resolution when multiple editors show the same file** → Resolve
  against the focused editor's selection only, mirroring `openDiffEditor`'s existing
  candidate-selection logic.

## Open Questions

- Concrete default keybinding chords (decide during implementation to avoid conflicts).
- Whether partial **reject** of removed lines is worth supporting in v1 or deferred.
- Agent hook shape: is `executeCommand` sufficient, or is a documented file/CLI signal
  needed for fully headless invocation?
