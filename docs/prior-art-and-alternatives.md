# Prior Art & Alternatives

*What already exists for "per-hunk review of AI edits," how close each is to the
[review-flow model](interactive-review-model.md) we want, and whether to build, fork, or
contribute. For the deep technical read on the closest tool, see
[hunkwise-evaluation.md](hunkwise-evaluation.md).*

---

## Capability comparison

Target = the "Cursor classic" review flow: chat-driven, multi-file, walk-a-queue-to-closure.

| Capability | monaco demo | **hunkwise** | Copilot Edits | Continue / Cline | **Target** |
|---|:---:|:---:|:---:|:---:|:---:|
| Inline red/green diff | ✓ | ✓ | ✓ | ✓ | ✓ |
| Per-hunk accept/reject | ✓ | ✓ | ✓ | ✓ | ✓ |
| Per-line / range | ✗ | ✗ | ~ | ~ | ✓ |
| Multi-file sidebar | ✗ | ✓ | ✓ | ✓ | ✓ |
| **Auto-advance to next** | ✗ | ✓ | ✗ | ~ | ✓ |
| **Review-complete state** | ✗ | ✗ (by design) | ~ | ✗ | ✓ |
| Tool-agnostic (any edit) | — | ✓ (git baseline) | ✗ (Copilot only) | ✗ (own agent) | desirable |
| Marketplace-shippable | — | ✗ (proposed API) | ✓ (built-in) | ✓ | want ✓ |
| Chat-driven changeset boundary | ✗ | ✗ (passive monitor) | ✓ | ✓ | ✓ |

Legend: ✓ yes · ~ partial · ✗ no · — n/a

## The players

- **[hunkwise](https://github.com/molon/hunkwise)** — the closest existing thing: a real,
  MIT-licensed VS Code extension doing per-hunk accept/discard for *any* external file change
  (built for CLI agents like Claude Code / OpenCode that have no native IDE review). Has
  inline diff, multi-file sidebar, auto-advance, and even a diff-editor mode. Its gaps versus
  our target are **architectural, not cosmetic** — see the evaluation doc. **This is the
  build-vs-buy pivot.**
- **[monaco-inline-diff-editor](https://github.com/Dimitri-WEI-Lingfeng/monaco-inline-diff-editor-with-accept-reject-undo)**
  — a single-file, copy-paste **demo** (no npm package, no multi-file, no queue). Useful only
  as a *rendering + undo-stack* reference.
- **GitHub Copilot Edits / agent mode** — ships native per-hunk gutter accept/reject +
  per-file accept-all/reject-all. A real implementation of much of this — but **Copilot-only**
  and not a walk-to-completion queue.
- **Continue / Cline** — both implement inline diff + accept/reject as **pure marketplace
  extensions** (no proposed API), tied to their own agent. Proof the core is shippable on
  stable APIs.
- **Native Claude Code / Codex support** — repeatedly requested
  ([claude-code #31395](https://github.com/anthropics/claude-code/issues/31395),
  [#42448](https://github.com/anthropics/claude-code/issues/42448),
  [#61794](https://github.com/anthropics/claude-code/issues/61794),
  [codex #12082](https://github.com/openai/codex/issues/12082)) but **not shipped and not
  committed to** (#31395 closed as duplicate, no maintainer plan). The gap for CLI/agent tools
  is real and open — the plugin is **not** obviated.

## The idea worth stealing: baseline-diffing = tool-agnostic

hunkwise's core architectural move is to **not integrate with any specific AI**. It snapshots
files into a private git repo as *baselines*, then diffs live content against them. Any tool
(or script, or human) that writes a file triggers review. This makes it work with Claude
Code, Codex, Aider, and hand edits alike — for free. Whatever we build should keep this
property rather than hard-wiring to one agent.

The tension: our target model is **chat-driven with a bounded changeset** ("review *this
turn's* edits to completion"), whereas hunkwise's baseline-diffing is a **continuous,
unbounded monitor** (like a live view of the git working tree). That difference is exactly
why hunkwise has no "review-complete" state — there's no turn boundary to complete. Reconciling
"tool-agnostic" with "bounded changeset + closure" is a genuine design question for us. See
the evaluation doc's "Architectural fit" section.

## Build vs. buy — recommendation

The plugin is **not obviated**, but starting from zero would be wasteful. Three paths, best
first:

1. **Fork/extend hunkwise (recommended starting hypothesis).** It already solved the hard,
   unglamorous parts (change tracking, baseline git, diff engine, rendering, multi-file
   sidebar, auto-advance, rename/delete edge cases, tests). We'd add the *flow* layer
   (changeset boundary + review-complete state + per-line actions) and decide on the
   proposed-API question. Fastest route to our actual differentiator. Debt is enumerated in
   the evaluation doc.
2. **Contribute upstream to hunkwise.** If the (single) maintainer is receptive, the flow
   features benefit everyone and we avoid a fork's divergence cost. Gated on maintainer
   responsiveness — which looks uncertain (see maturity assessment).
3. **Build fresh, borrow the architecture.** Full control and cleanly marketplace-shippable
   (if we avoid proposed APIs), at the cost of reimplementing ~6.5k LOC of solved problems.

**Next concrete step:** a hands-on trial of hunkwise driving a real Claude Code session, to
feel how close it is and where it fails the walk-a-queue-to-closure test. That trial, plus the
fork-debt assessment, decides between paths 1 and 3.

> **Update (2026-07-04):** the API question is decided — **stable API only**, no
> `editorInsets` (see [hunkwise-evaluation.md §8](hunkwise-evaluation.md)). Architecture and
> phased plan are in [design.md](design.md). Still open: fork hunkwise vs. build fresh (both
> stable-only).

## Sources

- [hunkwise](https://github.com/molon/hunkwise) ·
  [monaco demo](https://github.com/Dimitri-WEI-Lingfeng/monaco-inline-diff-editor-with-accept-reject-undo)
- Claude Code per-hunk requests:
  [#31395](https://github.com/anthropics/claude-code/issues/31395),
  [#42448](https://github.com/anthropics/claude-code/issues/42448),
  [#61794](https://github.com/anthropics/claude-code/issues/61794),
  [#33932](https://github.com/anthropics/claude-code/issues/33932)
- [OpenAI Codex native-diff request #12082](https://github.com/openai/codex/issues/12082)
- [Continue — how Edit works](https://docs.continue.dev/features/edit/how-it-works) ·
  [Cline](https://github.com/cline/cline)
