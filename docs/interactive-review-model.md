# The Interactive Review Editing Model

*The "Cursor classic" experience this project aims to reproduce: a **review flow** for
walking a queue of AI-proposed edits to completion — not a diff viewer, and not a
session-level "Review" button.*

> **Companion documents** (this file stays focused on the *concept*):
> - [prior-art-and-alternatives.md](prior-art-and-alternatives.md) — what already exists, a
>   capability comparison, and the build-vs-buy recommendation.
> - [hunkwise-evaluation.md](hunkwise-evaluation.md) — deep evaluation of the closest existing
>   tool: maturity, the proposed-API question, the architectural fit, and fork debt.

---

## 1. The mental model: walking a queue of pending edits

The interaction we're after is, concretely:

1. You click a changed file.
2. The editor shows that file in an **inline red/green review mode** — *not* primarily a
   side-by-side comparison.
3. Each change / hunk is treated like a **pending suggestion**.
4. You can **accept / keep / stage** that change, or **reject / undo / revert** it.
5. After you act, it **advances you to the next change** (or the next file).
6. There is a felt sense of *"I am walking a queue of edits until the review is done."*

That is much closer to **Word Track Changes**, **`git add -p`**, or a **code-review wizard**
than to a normal diff viewer.

> **Why the framing matters.** A diff viewer answers *"what changed?"* — it's a static
> comparison artifact. A review flow answers *"have I dispositioned every change yet?"* — a
> stateful traversal with a start, a moving cursor, and a **completion state**. Auto-advance
> and a terminal "review complete" state are not polish; they are what make this a *flow*
> instead of manual browsing.

## 2. What it is *not*

The appeal of the old model was **red/green inline diffs** with accept/reject **file by
file, chunk by chunk**. The common complaint is that these are *not* substitutes for it:

- A **session-level "Review" button** — bundles everything into one after-the-fact artifact
  and loses the per-hunk, walk-the-queue flow.
- **Passive highlighting** — shows you what changed but gives no disposition loop, no
  advance, no closure.

Both give you the *artifact* while deleting the *flow*.

## 3. Trigger and scope: chat-driven, multi-file, reviewed in the center

Two clarifications that distinguish this from `Cmd+K`-style inline editing:

- **The request comes from chat**, off to the side — not from an edit widget anchored at
  your cursor.
- **The changeset is potentially multi-file.** The review flow gathers every touched file
  into one traversal; the **center editor area is the review surface**, and you walk file →
  file, hunk → hunk to completion.

So the interactivity isn't about edits happening "at my cursor." It's about a tight,
reversible **review loop over a changeset**, however large.

## 4. The required feature set

| Feature | Why it matters |
|---|---|
| **Inline unified diff** | Keeps you *in the code*, not in a comparison artifact |
| **Per-hunk accept / reject** | Lets you make *local* decisions |
| **Per-line or selected-range actions** | Handles messy hunks that mix good and bad |
| **Auto-advance to next change** | Makes it a *review flow*, not manual browsing |
| **Next-file / review-complete state** | Gives *closure* — you know when you're done |
| **Stage *and* revert both available** | Two real dispositions, not one |
| **Symmetrical "accept" and "reject" actions** | Neither disposition is second-class |

The **symmetry principle** is load-bearing: accept and reject must be equally cheap and
equally reachable (keybinding, affordance, and undo). The moment one is a button and the
other is "manually select and delete," the flow breaks down on messy hunks.

## 5. Where Cursor moved (2.x → agent-first) and how to get the old feel back

Cursor's newer **Agent Window shifted toward session-level review** — the batch artifact,
not the per-hunk queue. Per Cursor staff, the settings that get *closest to the old
behavior* are:

- **Auto-Run off** — so edits become pending suggestions you disposition, not
  already-applied changes you audit after the fact.
- **Plan Mode** — keeps a reviewable intent step in front of the edits.
- **Inline diffs** — the red/green in-editor rendering rather than a passive review pane.

This is the tell that the *review flow* and the *agent batch-review* model are genuinely
different experiences sitting on the same diff machinery — and that this project is
deliberately targeting the former.

## 6. Why this differs from most other tooling

- **GitHub Copilot (classic)** grew up as autocomplete + a chat panel; its review story is
  bolted on at the *git* layer (a "review changes" button over staged/unstaged diffs), not
  an in-editor per-hunk queue.
- **Windsurf (Cascade)** is the same species as Cursor — inline staged diffs with
  accept/reject — but has itself drifted (a reported regression removed per-change
  accept/reject in favor of auto-applied edits with a non-interactive diff), the same
  session-level-vs-per-hunk erosion.
- The distinguishing property across all of them is whether the tool offers a **disposition
  queue with closure**, or merely a **diff to look at**.

## 7. The hard part

Rendering diffs and wiring accept/reject buttons is the *easy* 80%. The part with no
built-in VS Code API — and the actual core of this project — is the **changeset state
machine**: tracking every file/hunk's disposition (pending / accepted / rejected), driving
**auto-advance**, and computing the **review-complete** terminal state that gives the flow
closure. Everyone who has built adjacent tools ships the diffs and skips this; it's the
wedge.

For the concrete VS Code API surface, the stable-vs-proposed-API question, and how existing
tools implement the rendering, see
[hunkwise-evaluation.md](hunkwise-evaluation.md) and
[prior-art-and-alternatives.md](prior-art-and-alternatives.md).

## Sources

- [Cursor 2.0 changelog — agent-first interface](https://cursor.com/changelog/2-0)
- [Cursor forum: 2.0 feedback / loss of per-hunk review](https://forum.cursor.com/t/2-0-a-step-in-the-wrong-direction/139648)
- [Cursor forum: disable Diffs & Review interface](https://forum.cursor.com/t/option-to-disable-diffs-review-interface-in-editor/131728)
- [Windsurf Cascade docs](https://docs.windsurf.com/windsurf/cascade/cascade)
- [Codeium/Windsurf accept-reject regression (issue #131)](https://github.com/Exafunction/codeium/issues/131)
