# Design — stable-API review-flow extension

*Committed direction: build the [review-flow model](interactive-review-model.md) as a VS Code
extension using **stable APIs only** (decision recorded in
[hunkwise-evaluation.md §8](hunkwise-evaluation.md)). `editorInsets` is deferred to a possible
future enhanced mode. This doc is the architecture + phased plan.*

---

## 1. Two layers

**Layer A — mechanics (mostly solved; borrow from hunkwise):** baseline tracking, hunk
computation, rendering, per-hunk apply/revert, multi-file listing, edge cases (rename/delete,
`.gitignore`, non-ASCII paths). We keep this; we do not reinvent it.

**Layer B — the flow (our differentiator; nobody ships it):** a bounded **changeset** with a
disposition state machine, **auto-advance**, and a **review-complete** terminal state. This is
the wedge.

## 2. Layer A — rendering on stable APIs

| Concern | Stable mechanism |
|---|---|
| Baseline (what "changed" is diffed against) | Private-git baseline snapshot (hunkwise's approach), or SCM quickdiff provider |
| Hunk computation | `diff` (`diffLines`), stable position-derived hunk IDs |
| Show removed + added lines | **Native diff editor** (`TabInputTextDiff`) with a `TextDocumentContentProvider` serving the `baseline:` side |
| Per-hunk accept / reject controls | **`CodeLensProvider`** — `$(check) Accept` / `$(x) Discard` above each hunk |
| Line highlighting (added) | `TextEditorDecorationType` |
| Apply accepted / revert rejected | `WorkspaceEdit` + editor undo stack; update baseline on accept, restore baseline on reject |
| Multi-file surface | Sidebar **`TreeView`** (stable) — files → hunks, counts, batch actions, review-complete badge |
| Keyboard symmetry + advance | Contributed commands + keybindings for accept/reject/next/prev |

**Known stable-path limitation:** you cannot float buttons or render a deleted-lines block
*inside the normal editor* without `editorInsets`. Mitigation: use the **native diff editor**
as the primary review surface (removed lines shown natively there); optionally offer a
decorations-only "in-file" mode for added-line highlighting where removed content is viewed via
peek. Accept this as the cost of shippability.

## 3. Layer B — the changeset state machine (the core work)

```
Changeset { id, trigger, files: FileEntry[], status }
FileEntry { path, hunks: Hunk[] }
Hunk      { id, range, disposition: 'pending' | 'accepted' | 'rejected' }

status:  open ──(all hunks dispositioned)──▶ complete ──(user closes / auto)──▶ closed
```

- **Open a changeset** on a trigger: (a) explicit command *"Begin review of pending changes"*
  (tool-agnostic — snapshot baseline now, like hunkwise), and/or (b) a hook an agent calls to
  mark a turn boundary. Keeps the tool-agnostic property while adding the *bounded* boundary
  hunkwise lacks.
- **Auto-advance:** after a disposition, reveal the next `pending` hunk (same file → next
  file). This is what turns "a diff to browse" into "a queue you walk."
- **Review-complete:** when no `pending` hunks remain, surface a terminal state (status-bar +
  sidebar badge + optional notification) — the *closure* the model demands.
- **Symmetry:** accept and reject are equally cheap — same affordance weight, both keybound,
  both one-gesture-undoable.

## 4. Phased plan

- **Phase 0 — Scaffold.** Resolve fork-vs-fresh; stand up the extension, activation, a no-op
  sidebar. *Exit: installs and activates on stable VS Code.*
- **Phase 1 — Single-file review.** Baseline + diff engine + native-diff-editor + CodeLens
  accept/reject for one file. *Exit: accept/reject a hunk, baseline updates correctly.*
- **Phase 2 — Multi-file changeset.** The `Changeset`/`FileEntry`/`Hunk` model + sidebar
  TreeView + per-file and all-files batch actions. *Exit: review a multi-file change end to end.*
- **Phase 3 — The flow.** Auto-advance + review-complete state + status surfacing. *Exit: "walk
  the queue to closure" feels like Cursor classic.*
- **Phase 4 — Polish.** Per-line/range actions on messy hunks; keybindings + accept/reject
  symmetry; optional in-file decorations mode.
- **Deferred — Enhanced inline mode.** `editorInsets` floating bar + in-buffer deleted block,
  gated behind the proposed API. Explicitly out of scope for v1.

## 4a. Phase 0 — status (2026-07-04): DONE (fork established, stable-only, compiles)

- Forked `molon/hunkwise` into repo root (buildable subset: `src/`, `media/`, configs,
  `LICENSE`). Pristine reference retained at [reference/hunkwise/](reference/hunkwise/).
- **Removed the proposed API:** deleted `decorationManager.ts` (sole `editorInsets` user) and
  `vscode.proposed.editorInsets.d.ts`; unwired `DecorationManager` from `extension.ts`; dropped
  `enabledApiProposals` from `package.json`. The stable `DiffCodeLensProvider` path is untouched
  and remains the review surface.
- **Rebranded** `package.json` → `davemackey.vsc-interactive-review` / "Interactive Review",
  v0.0.1. Scoped `tsconfig` to `src/**` (was globbing the reference clone).
- **Verifies:** `npm run compile` clean; `72/73` unit tests pass.

**Known issue (pre-existing, not ours):** 1 unit test fails —
`HunkwiseGit › NFD paths … found as NFC` — a Unicode-normalization test that assumes macOS
filesystem behavior; fails on Linux. We didn't touch the relevant files. Investigate later.

**Follow-ups before real feature work:**
- **Confirm publisher id** — `davemackey` is a placeholder inferred from the email; change if wrong.
- **Rename internal ids** (mechanical sweep): `hunkwise.*` command ids, `hunkwiseToolbar` /
  `hunkwisePanel` view ids, `hunkwise-baseline` URI scheme, and the `.vscode/hunkwise/` state dir.
  Kept as-is this pass to land a compiling fork first.
- Add our own `README.md` / fork `NOTICE` (retain hunkwise MIT attribution — `LICENSE` kept).

## 5. Open decisions

1. **Fork hunkwise vs. build fresh** — blocks Phase 0. Fork inherits the solved Layer A + tests
   but needs editorInsets stripped/optionalized and architectural surgery for the changeset
   boundary; fresh is clean/shippable but reimplements ~6.5k LOC. *(Pending user call.)*
2. **Trigger model** — explicit command vs. agent hook vs. both (§3).
3. **Primary surface** — native diff editor (robust) vs. in-file decorations (closer feel,
   more limited without insets).
