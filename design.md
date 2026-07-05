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
  `LICENSE`). Pristine upstream: [github.com/molon/hunkwise](https://github.com/molon/hunkwise)
  (cloned locally alongside this repo at `../hunkwise-reference/`).
- **Removed the proposed API:** deleted `decorationManager.ts` (sole `editorInsets` user) and
  `vscode.proposed.editorInsets.d.ts`; unwired `DecorationManager` from `extension.ts`; dropped
  `enabledApiProposals` from `package.json`. The stable `DiffCodeLensProvider` path is untouched
  and remains the review surface.
- **Rebranded** `package.json` → `eccentricqualitysolutions.vsc-interactive-review` / "Interactive Review",
  v0.0.1. Scoped `tsconfig` to `src/**` (was globbing the reference clone).
- **Verifies:** `npm run compile` clean; `72/73` unit tests pass.

**Known issue (pre-existing, not ours):** 1 unit test fails —
`HunkwiseGit › NFD paths … found as NFC` — a Unicode-normalization test that assumes macOS
filesystem behavior; fails on Linux. We didn't touch the relevant files. Investigate later.

**Follow-ups before real feature work:**
- **Publisher id** — set to `eccentricqualitysolutions` (2026-07-05).
- **Rename internal ids** — DONE (2026-07-05). Two passes:
  (1) *contract ids:* `hunkwise.*` commands → `interactiveReview.*`; views
  `hunkwisePanel`/`hunkwiseToolbar` → `interactiveReview*`; scheme `hunkwise-baseline` →
  `interactive-review-baseline`; state dir `.vscode/hunkwise/` → `.vscode/interactive-review/`
  (+ `.gitignore` entry/marker); webview text.
  (2) *internal identifiers* (per user, no hunkwise left in code): `HunkwiseGit`→`BaselineGit`
  (`hunkwiseGit.ts`→`baselineGit.ts`), `hunkwiseDir`→`stateDir`, `HUNKWISE_ENTRY`→`IGNORE_ENTRY`,
  `hunkwiseGitEnv`→`baselineGitEnv`, `enable/disableHunkwise`→`enable/disableReview`,
  `__hunkwiseTestRoot`→`__reviewTestRoot`, `isActiveHunkwiseDiffTab`→`isActiveReviewDiffTab`,
  test temp-dir prefixes, labels & comments. Only `molon/hunkwise` (attribution) kept.
  Verified: compile clean; unit 72/73; integration review-loop suites 100% pass.
- **Attribution** — DONE (2026-07-05). `LICENSE` now carries both molon's (original) and
  Eccentric Quality Solutions' (modifications) MIT copyright; added `README.md` with a prominent
  Credits section stating this is a fork of molon/hunkwise and what changed.

## 4b. Phase 1 — status (2026-07-05): DONE (inherited from fork, verified)

Phase 1's stable path (baseline `hunkwise-baseline:` content provider → `computeHunks` diff
engine → native diff editor via `TabInputTextDiff` → `$(check) Accept` / `$(x) Discard`
CodeLens → `WorkspaceEdit` apply + baseline update) is **already implemented by the fork** —
no new code needed. Verification exercised the real extension in headless VS Code:

- **Exit criterion MET:** accept/reject a hunk → baseline updates correctly. All review-loop
  integration tests pass: `diff editor` suite (CodeLens visibility, accept-by-file-scheme,
  last-hunk-closes-tab), hunk navigation (accept/discard jumps to next hunk; last hunk exits
  reviewing), and baseline-update edge cases (empty file, new file null→content, restore).
- **Unit:** 72/73 (the 1 fail = known macOS-only Unicode NFC/NFD test, not ours).
- **Integration:** 50 passing / 1 pending / **17 failing** — see known-issue below.

**Known issue — 17 integration failures in the continuous-monitor layer (pre-existing, not a
fork regression):** all 17 are in `fileWatcher` / `gitignoreManager` / branch-switch tests
(ignore ×11, startup ×2, rename ×2, filewatch ×1, branchSwitch ×1) — code the Phase 0 fork
never touched. Two causes: (a) Linux `fs.watch` timing/coalescing differs from the macOS fs
hunkwise was built on → 10 of 17 are `Condition not met within timeout`; (b) the persistent
on-disk integration workspace (`src/test/integration/workspace/`, plus accumulated
`.vscode-test/user-data/`) leaks state across runs → order-dependent assertion failures (e.g.
`clearOnBranchSwitch` reads a prior test's persisted `true`). **Not in Phase 1 scope** (review
loop, not the monitor), but **must be triaged before Phase 2**, which builds directly on the
multi-file monitor these tests cover. Fix direction: isolate each test's workspace + settings,
and make `waitForCondition` robust to Linux watch latency.

## 5. Open decisions

1. **Fork hunkwise vs. build fresh** — blocks Phase 0. Fork inherits the solved Layer A + tests
   but needs editorInsets stripped/optionalized and architectural surgery for the changeset
   boundary; fresh is clean/shippable but reimplements ~6.5k LOC. *(Pending user call.)*
2. **Trigger model** — explicit command vs. agent hook vs. both (§3).
3. **Primary surface** — native diff editor (robust) vs. in-file decorations (closer feel,
   more limited without insets).
