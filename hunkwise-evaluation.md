# hunkwise — Evaluation

*Deep read of [hunkwise](https://github.com/molon/hunkwise) as a base for this project.
Source: [github.com/molon/hunkwise](https://github.com/molon/hunkwise) (v0.0.29, MIT),
cloned locally under `reference/hunkwise/`. Companion to
[prior-art-and-alternatives.md](prior-art-and-alternatives.md) and the
[review-flow model](interactive-review-model.md).*

**Bottom line:** hunkwise is a *real* alternative — a working, tested implementation of most
of the mechanics — and the strongest starting point. But (1) it's young and single-maintainer
with a ~3-month-dormant history, (2) its published mode depends on a proposed API that blocks
the marketplace, though it *already contains* a stable-API path, and (3) its passive-monitor
model is a real semantic mismatch with our chat-driven, bounded-changeset target. Forkable,
with eyes open.

---

## 1. What it actually is

A VS Code extension giving **per-hunk Accept/Discard for any external file change**. It exists
because CLI agents (Claude Code, OpenCode) have no native IDE review UI the way Cursor /
Windsurf / Copilot do. Architecture (from its `CLAUDE.md` and source):

- **`FileWatcher`** — watches all workspace files; distinguishes *external* writes (AI/scripts
  → trigger review) from *manual* typing (buffer matches disk → silently update baseline).
- **`HunkwiseGit`** — persists **baselines** in a private git repo at `.vscode/hunkwise/git/`
  (single amended commit). Survives restarts.
- **`DiffEngine`** — `Diff.diffLines(baseline, current)`; stable hunk IDs from position.
- **`StateManager`** — in-memory `Map<path, {status, baseline}>`, mutations serialized to git
  via a promise queue.
- **`DecorationManager`** and **`DiffCodeLensProvider`** — the two rendering paths (below).
- **`ReviewPanel`** — sidebar webview: all pending files, batch accept/discard.

It handles the *unglamorous hard cases*: rename/delete migration, `.gitignore` sync, self-edit
suppression, non-ASCII/Unicode NFC paths, new-vs-empty-vs-existing file (`baseline
null|''|str`), deleted-file restore. Those edge cases are months of bug reports someone else
already absorbed.

## 2. Maturity — a real but young, single-maintainer project

| Signal | Reading |
|---|---|
| Version `0.0.29`, MIT | Pre-1.0; API/behavior may still churn. Clean license for forking. |
| ~31 commits, one author (`molon`) | **Bus factor = 1.** No community of committers. |
| Active **Mar 22 – Apr 2, 2026**, then quiet | Intense ~11-day burst; **~3 months dormant** as of Jul 2026. |
| ~6,500 LOC TypeScript | Substantial but tractable to read/own. |
| Unit **and** integration tests | Above-average rigor: `diffEngine`/`git`/`gitignore` unit tests + real-extension-host integration tests (rename, delete-restore, hunk navigation, .gitignore, lifecycle). |
| Excellent `CLAUDE.md` | The architecture and invariants are documented — lowers fork cost a lot. |
| ~71 stars | Modest traction; not a de-facto standard. |

**Verdict:** engineering quality is good (tests + docs), but sustainability is weak
(one dormant maintainer). If we depend on it, we should assume **we become the maintainer**.

## 3. The proposed-API question — the crux

hunkwise declares `enabledApiProposals: ["editorInsets"]` and its README says it **cannot be
installed from the marketplace** as a result. Two facts change the picture:

**(a) `editorInsets` is still a proposed API today.** It's `createWebviewTextEditorInset`
(embed a webview anchored at an editor line; VS Code issue **#85682**). It has been *proposed
since 2019* and remains proposed on `vscode` `main` as of July 2026 — a long-lived,
never-stabilized API. Consequences of using it:
- No marketplace publish. Distribution = VS Code **Insiders**, or stable with
  `argv.json` → `"enable-proposed-api": ["<publisher.ext>"]`.
- Works on macOS/Windows stable via that flag; **flaky on some Linux stable builds** (their
  [issue #20](https://github.com/molon/hunkwise/issues/20)) — may require Insiders.
- Proposed APIs can change or vanish between releases — ongoing breakage risk.

**(b) hunkwise already has a stable-API path.** It renders two ways:

| Path | API | Marketplace-safe? | UX |
|---|---|:---:|---|
| `DecorationManager` | **`editorInsets`** (proposed) + `TextEditorDecorationType` | ✗ | Rich: floating Accept/Discard button bar + rendered red deleted-lines block, inline in the *normal* editor |
| `DiffCodeLensProvider` | **CodeLens** (stable) in the **native diff editor** + a `hunkwise-baseline:` virtual-doc content provider | ✓ | `$(check) Accept` / `$(x) Discard` CodeLens above each hunk, shown in the side/inline diff editor |

## 4. Can we achieve the target WITHOUT the experimental API? — Yes.

hunkwise's own CodeLens/diff-editor path, plus Continue and Cline (both marketplace
extensions with no proposed API), prove the **core flow — inline red/green, per-hunk
accept/reject, auto-advance, multi-file — is fully achievable on stable APIs**:

- **Added lines / highlighting** → `TextEditorDecorationType` (stable).
- **Per-hunk accept/reject affordances** → **CodeLens** (stable), or gutter/hover actions.
- **Showing removed lines inline** → the **native diff editor** against a virtual baseline
  document (`TextDocumentContentProvider`, stable), or decoration `before`/`after` tricks.
- **Apply/revert** → `WorkspaceEdit` + the editor undo stack (stable).
- **Multi-file navigation** → the multi-diff editor / a sidebar `TreeView` or webview.

**What `editorInsets` buys (and it's only polish):** the *floating button bar* and a rendered
deleted-lines block **inside the normal editor buffer** — i.e. the slickest "stay in one
file, buttons hover over the hunk" feel. Without it you fall back to CodeLens (its own line)
and/or the native diff editor. That is a **UX-fidelity trade, not a capability loss**.

**Design implication:** we can ship to the marketplace by committing to the stable path
(CodeLens + decorations + native-diff-editor / virtual baseline doc). If we later want the
in-normal-editor floating widgets, that becomes an *optional enhanced mode* gated on the
proposed API — not a hard dependency.

### Visual comparison of the two flows

A side-by-side mockup of the accept/deny affordance in each path — the stable CodeLens
actions vs. the proposed `editorInsets` floating button bar + inline deleted-block — is at
[review-flow-comparison.html](review-flow-comparison.html) (open in a browser; it's
theme-aware). The mockups are reconstructed from the real rendering code, not live
screenshots. The upshot the picture makes obvious: **the proposed API buys polish (floating
buttons, in-buffer deleted block), not capability.**

## 5. Architectural fit — the real mismatch

hunkwise is a **continuous, unbounded monitor**: baseline-diff every changed file, forever,
with no notion of "this AI turn's changeset" and therefore **no review-complete state** (there
is nothing to complete). Our [target](interactive-review-model.md) is **chat-driven and
bounded**: review *this turn's* multi-file changeset, walk it to closure, done.

So the gap versus our model isn't a missing button — it's a **missing concept**: a *changeset*
(a turn boundary) with its own lifecycle and terminal state. Bolting that onto hunkwise means:
- Introducing a `Changeset` aggregate over the currently-pending hunks (grouped by an agent
  turn / trigger), on top of its per-file baseline map.
- A traversal + **review-complete** state scoped to that changeset.
- Reconciling "tool-agnostic passive watching" (its strength) with "bounded per-turn review"
  (our requirement) — e.g. open a changeset on first external write after a trigger and close
  it when all its hunks are dispositioned.

This is precisely the **changeset state machine** flagged as the core of the project in the
[model doc §7](interactive-review-model.md). hunkwise gives us everything *below* that line;
the state machine is the part we add.

## 6. Fork debt — what we'd take on

If we fork (path 1 in the build-vs-buy):

- **Maintainership transfers to us.** Single dormant upstream → assume no upstream fixes;
  we own the ~6.5k LOC (mitigated by good tests + `CLAUDE.md`).
- **Proposed-API decision forced up front.** Keep `editorInsets` (no marketplace, Insiders/
  argv.json, Linux flakiness) *or* invest to make the stable CodeLens/diff-editor path the
  default and drop/optionalize `editorInsets`.
- **Architectural surgery**, not just additions — introducing the changeset/turn boundary
  touches `StateManager`, `ReviewPanel`, and the rendering paths, because the whole codebase
  currently assumes an unbounded pending-set.
- **License hygiene:** MIT → keep the copyright/license and attribution.
- **Divergence cost:** any future upstream commits must be cherry-picked manually.
- **Model risk to re-check on the hands-on trial:** the passive-watch heuristic
  (buffer-vs-disk to tell "AI wrote" from "user typed") has known failure modes (their FAQ:
  drag-from-Finder timing). Our chat-driven trigger might let us *replace* that heuristic with
  an explicit "changeset opens now" signal — potentially simpler and more robust than what we
  inherit.

## 7. Recommendation

hunkwise is the **right base to prototype against**, not a drop-in solution. Concretely:
1. **Hands-on trial** first (drive Claude Code through it) to confirm feel and failure points.
2. If it holds up, **fork** and immediately (a) make the **stable CodeLens/diff-editor path
   the default** for marketplace shippability, and (b) add the **changeset + review-complete**
   layer — our differentiator.
3. Keep hunkwise's **baseline-diffing** engine and edge-case handling; that's the value we're
   not reinventing.

## 8. Decision (2026-07-04): stable API only

**We are committing to the stable-API path — no `editorInsets`.** The floating in-editor
button bar is polish we are choosing to forgo (at least initially) in exchange for a
Marketplace-shippable, normal-install extension with no Insiders/`argv.json`/Linux friction.
Accept/reject is rendered via **CodeLens in a native diff editor against a virtual baseline
document**, with decorations for line highlighting — the path hunkwise already proves works
and Cline/Continue ship.

`editorInsets` is explicitly **deferred to a possible future "enhanced inline mode,"** not a
dependency. The design and phased plan for the stable build live in [design.md](design.md).
Open decision that gates scaffolding: **fork hunkwise vs. build fresh** (both stable-only).

## Sources

- [hunkwise repo](https://github.com/molon/hunkwise) · local clone under `reference/hunkwise/`
  · [FAQ / Linux note](https://github.com/molon/hunkwise/issues/20)
- [VS Code: Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
  · `editorInsets` = VS Code issue #85682 (`createWebviewTextEditorInset`), still proposed on
  `main`, Jul 2026.
- Stable-API proof points: [Continue — how Edit works](https://docs.continue.dev/features/edit/how-it-works),
  [Cline](https://github.com/cline/cline).
