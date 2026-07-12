# Bug: Claude/terminal edits not captured when the file is open in the editor

**Status:** Open-file fix + diagnostic logging implemented; regression tests added (2026-07-12). Cause B (closed-file, no baseline) left as a documented decision — see §5.
**Reported:** 2026-07-12 — "It does not appear to capture Claude edits when they are made from the terminal."
**Affected code:** [fileWatcher.ts](../src/fileWatcher.ts) `onDiskChange` (≈L447–454) and its twin in `onDiskCreate` (≈L312–322)
**Prior art in this repo:** This is the "reload race" already documented as a *known fragility* in [design.md §4f](design.md) — now observed biting.

> **⚠️ Update (2026-07-12):** The reporter clarified the missed files were **not all open** in the
> editor. The buffer-match heuristic below (§1–§4) only affects *open* files, so it is **not the
> primary cause**. For closed files the real suspects are watcher filtering (gitignore /
> `files.watcherExclude`) and a silent null-baseline snapshot — see **§5**. §1–§4 remain valid for
> the open-file subset.

---

## 1. Summary

The extension decides whether a disk change is *"the human saved it here"* (absorb silently into
the baseline, no review hunk) or *"an external tool wrote it"* (queue for review) using a
**buffer-match heuristic**:

```ts
// fileWatcher.ts onDiskChange, ~L447
const openDoc = vscode.workspace.textDocuments.find(
  d => d.uri.scheme === 'file' && normalizePath(d.uri.fsPath) === filePath
);
if (openDoc && openDoc.getText() === diskContent) {
  this.stateManager.snapshotFile(filePath, diskContent);   // treat as manual save → NO hunk
  return;
}
```

The heuristic is fooled by a VSCode behavior: **when an external process writes to a file you
have open and *unmodified*, VSCode silently reloads the editor buffer to match disk.** By the time
`onDiskChange` reads `openDoc.getText()`, it can already equal `diskContent`, so Claude's edit is
misclassified as a manual save and folded into the baseline — **it never appears in the review
queue.**

- **File *not* open in an editor** → `openDoc` is `undefined`, heuristic skipped, edit is reviewed. ✅ Works.
- **File *open and clean*** → buffer reloads to match disk → edit silently absorbed. ❌ The bug.
- **Intermittent** because `FileSystemWatcher.onDidChange` and VSCode's buffer reload are two
  independent consumers of the same OS signal with **no ordering guarantee**. If the watcher wins,
  the edit surfaces; if the reload wins, it's swallowed. Auto-save makes the buffer track disk
  continuously, so on open files it misfires nearly every time.

**Fundamental point:** a human's Ctrl+S and an external write to a clean open buffer are
*indistinguishable by content* — in both, buffer == disk. No content/`isDirty` comparison can ever
separate them. The only reliable discriminator is **event provenance**: a VSCode save fires
`onDidSaveTextDocument`; an external write never does.

---

## 2. The panel — do they agree?

Four independent specialists reviewed the diagnosis and proposed fix against the actual code.

| Reviewer | Agrees root cause is the buffer-match heuristic? | Agrees fix direction (event-based, not content-based)? |
|---|---|---|
| **Pragmatic engineer** | ✅ Yes — verified nothing else swallows the edit | ✅ Yes, with a content-anchored token |
| **VSCode API specialist** | ✅ Yes — confirmed silent reload + no ordering guarantee | ✅ Yes — `onDidSaveTextDocument` is the authoritative signal |
| **AI / agentic-tooling specialist** | ✅ Yes — matches design.md §4f prediction | ✅ Yes, but insufficient alone (see create-path + dirty-buffer) |
| **QA / test-strategy specialist** | ✅ Yes — and the current suite passes *vacuously* | ✅ Yes — prefers an edge-triggered token for testability |

**Unanimous** on the diagnosis. Unanimous that the fix must key off `onDidSaveTextDocument`, not
content. They diverge and add depth on the *exact* implementation and on adjacent bugs the original
diagnosis under-weighted.

---

## 3. Confirmed facts (VSCode API specialist)

1. **Silent reload is real and unconditional for clean buffers.** VSCode's file-editor model
   detects the on-disk change and reloads the in-memory model from disk. There is **no setting to
   disable it** for clean editors (request [microsoft/vscode#50472](https://github.com/microsoft/vscode/issues/50472)
   closed without change). A **dirty** buffer is *not* reloaded — VSCode shows a conflict instead,
   so `getText() !== diskContent` and the heuristic would not misfire in that sub-case.
2. **No ordering guarantee.** `createFileSystemWatcher` is serviced by the OS-native recursive
   watcher on the extension-host side; the buffer reload is driven by a *separate* subscription in
   the workbench. VSCode publishes no ordering between them. The `await fs.promises.readFile` on
   L429 adds an async tick that *biases toward* the reload having landed — worsening the odds.
3. **`onDidSaveTextDocument` is the correct positive discriminator.** It fires for explicit saves
   *and all auto-save modes* (`afterDelay`, `onFocusChange`, `onWindowChange` all route through the
   same `TextFileService.save()` pipeline). It **never** fires for external writes. Saves also do
   *not* emit `onDidChangeTextDocument`, so the two are cleanly separable.

---

## 4. Refinements the panel insists on (beyond the original diagnosis)

### 4.1 The reverse race — gate on saved *content*, not just the event

A naive "was there a save for this path in the last ~1s?" check has a symmetric hole: if the
watcher event is delivered *before* `onDidSaveTextDocument` fires, a genuine human save is
misclassified as external → spurious review hunk. Worse (AI specialist): if a human saves at nearly
the same moment Claude writes, a save event *did* fire but the disk bytes are Claude's — gating on
the event alone would absorb Claude's edit.

**Fix:** in the save handler, capture the exact text that was saved and store `path → savedText`.
Absorb-as-baseline only if a save is recorded **and `diskContent === savedText`**. This is robust
regardless of event ordering and regardless of buffer reloads. *(Pragmatic + AI + VSCode reviewers
converge here.)*

### 4.2 Timestamp window vs. edge-triggered token — prefer the token (QA)

The QA specialist argues a wall-clock `~1s` window is CI-flaky and needs fake timers to test. The
simpler, testable design is an **edge-triggered, consume-once token**:

```ts
// onDidSaveTextDocument(doc):
this.pendingManualSaves.set(normalizePath(doc.uri.fsPath), doc.getText());

// onDiskChange, replacing the getText()===diskContent block:
const savedText = this.pendingManualSaves.get(filePath);
if (savedText !== undefined) {
  this.pendingManualSaves.delete(filePath);          // consume once
  if (savedText === diskContent) {                    // it really was our save
    this.stateManager.snapshotFile(filePath, diskContent);
    return;
  }
}
// otherwise → enterReviewing (external write)
```

No timers, no clock, unit-testable by seeding the map. **Edge case to cover:** a save whose watcher
change never arrives (no-op/coalesced save) must not leave a stale token that later swallows a real
external edit — scope the token to the next change or clear it on a document-change boundary rather
than a wall-clock timer. *(If a timestamp window is kept instead, inject the clock — `now: () =>
number` — so tests advance virtual time.)*

### 4.3 `onDiskCreate` has the identical bug — fix both paths

The same `openDoc.getText() === diskContent` heuristic lives in `onDiskCreate` (L312–322). Two
reasons it matters:

- Some agent/formatter writes are **atomic rename-into-place** (write temp + `rename()`), which
  land as `DELETE`+`CREATE` — not `CHANGE`. These hit `onDiskCreate`.
- `onDidSaveTextDocument` does **not** help the create path (an atomic-rename create has no
  matching saved buffer). The create-path bug is narrower (needs an open buffer equal to the
  newly-created content) but real — e.g. an agent deletes-and-recreates an open file. Apply the
  same content-anchored save-token treatment; for atomic-rename creates with no save token, default
  to `enterReviewing`.

### 4.4 EOL / final-newline normalization (AI specialist)

Agents write `\n`; VSCode buffers may hold `\r\n` or add/trim a trailing newline per `files.eol` /
`files.insertFinalNewline`. Raw `===` can be false for semantically identical content (spurious
hunk) or true after normalization (spurious absorb). **Normalize EOL + final newline before any
content comparison.**

### 4.5 The dirty-buffer case needs an explicit product decision (AI specialist)

If Claude writes to a file the human has **dirty**, VSCode does not silently reload — disk and
buffer genuinely diverge and VSCode flags a conflict. Desired behavior: review Claude's disk write
against the turn baseline and surface the buffer conflict separately; do **not** silently fold
either side. This is a decision to make, not something the watcher should paper over.

### 4.6 Rapid multi-write churn (AI specialist)

Agents write the same file several times per turn (Edit → Edit → formatter) and many files at once.
The disk-event handlers are *un-debounced* and each does an async `fs.readFile`, creating a TOCTOU
on `diskContent`. Consider per-path debouncing of disk events and snapshotting comparison inputs at
enqueue time. (Lower priority than the core fix.)

---

## 5. UPDATE (2026-07-12): missed files were NOT all open → primary cause is elsewhere

The reporter clarified: **the missed files were not all open in the editor at the time.** Since the
buffer-match heuristic (§1) can only fire for *open* files, it cannot be the sole — or even primary —
cause. For a **closed** file, `onDiskChange` skips the buffer branch and runs:

```ts
// fileWatcher.ts:456-470
const gitBaseline = await git.getBaseline(filePath);
if (gitBaseline === undefined) {
  this.stateManager.snapshotFile(filePath, diskContent);   // silently adopt — NO hunk
  return;
}
this.enterReviewing(filePath, gitBaseline, diskContent);   // review it
```

`snapshotWorkspace` ([stateManager.ts:473](../src/stateManager.ts)) baselines **every non-ignored
readable file** at enable time, so a normal closed file that existed at enable *has* a baseline and
should reach `enterReviewing`. A closed-file edit therefore goes missing only via:

### Cause A — the watcher event never reaches `onDiskChange` (filtered/dropped before the baseline is consulted)

1. **gitignore / user ignore patterns (HIGH, in-code).** `shouldIgnore` (L424) returns early for any
   path matching a workspace `.gitignore`, a nested `.gitignore`, the global gitignore, or a user
   ignore pattern. Silent and systematic. **Most common systematic cause — check this first.**
2. **`files.watcherExclude` (HIGH).** `createFileSystemWatcher('**/*')` is a workspace-relative
   recursive pattern, serviced by the shared recursive watcher, which honors `files.watcherExclude`.
   Defaults exclude `**/.git/objects/**`, `**/node_modules/*/**`, `**/.hg/store/**`; users often add
   `**/dist`, build dirs, etc. Anything under an excluded glob fires **no event at all**.
3. **Files outside workspace folders (MEDIUM).** A string-pattern watcher only watches inside
   workspace folders.
4. **Symlinked directories / inotify watch exhaustion on Linux (LOW–MEDIUM).** Large trees can
   silently exhaust inotify watches; symlinked dirs aren't followed by default.

### Cause B — event arrives but `getBaseline` returns `undefined` → silent snapshot (L467)

Happens only for files with no baseline: binary / non-UTF-8 / unreadable at enable time (skipped at
[stateManager.ts:504](../src/stateManager.ts)), or files that were gitignored at enable (but those
are already filtered by Cause A.1). Also absorbs a terminal *modify* of a file that was untracked at
enable time. Worth fixing (surface for review or at least log), but a narrower cause than A.

### The decisive gap: `onDiskChange` has no entry logging

Every other handler (`onDiskCreate`, `onDiskDelete`) logs at entry and per-branch; `onDiskChange`
logs nothing at entry, and both silent-drop paths (`shouldIgnore` early-return at L424, and the
`getBaseline === undefined` snapshot at L467) emit **no** log line. A swallowed edit is invisible in
the "Interactive Review" output channel — you cannot tell Cause A (event never arrived) from Cause B
(baseline path swallowed it). **First action: add diagnostic logging** — entry line + which branch
fired — so a reproduction reveals the real cause instead of guessing. This also justifies making the
two silent drops log permanently: a "review pending edits" tool silently discarding an edit is its
worst failure mode.

### User-side checks to run now

1. Were the missed files matched by any `.gitignore` (workspace, nested, or global)?
2. Any custom `files.watcherExclude` globs in VSCode settings covering those paths?
3. Are the files inside the opened workspace folder?

---

## 6. Why the tests didn't catch it (QA specialist)

The suite passes for **exactly the wrong reason**: no test ever has an open `file`-scheme document
in front of `onDiskChange` on a *not-yet-reviewing* file, so the buggy branch is never entered.

- `filewatch.test.ts` writes via raw `fs` or `workspace.fs` — **never opens a TextDocument into an
  editor**, so `openDoc` is `undefined`. The test named *"external file modification preserves
  original baseline"* is the exact scenario but passes **vacuously**.
- `diffEditor.test.ts` etc. open the doc only *after* the file is already `reviewing`, so
  `onDiskChange` returns early at L438 and never reaches the heuristic.

### Required test cases

| # | Scenario | Expected after fix |
|---|---|---|
| A | External write to **open + clean** doc (the bug) | Enters `reviewing` with a hunk; baseline preserved |
| B | External write to **open + dirty** doc | Enters `reviewing`; classification independent of buffer-vs-disk |
| C | Genuine **manual save** | Absorbed into baseline, **no** hunk |
| D | Genuine **auto-save** (`files.autoSave`) | Absorbed, no hunk — proves the save gate covers autosave |
| E | External write to **closed** file (regression guard) | Enters `reviewing` — unchanged |
| F | External write to an **already-reviewing** file (regression) | Recompute path still taken |

**Determinism:** never race the real watcher against the real reload (passes/fails by luck). Add a
**test seam** — call `onDiskChange` directly (via `getFileWatcher()` in `helpers.ts`), injecting the
save-signal and the "open doc text" so a unit test can simulate "buffer already reloaded to match
disk" and assert the fix ignores content entirely and keys only off the save event. Cases A, C, D,
E are the priority: A proves the bug, C+D prove the legitimate save-absorption still works, E guards
against over-correcting. The tiny `src/test/__mocks__/vscode.ts` stub cannot model this; use the
integration tier (real vscode API) plus the injected seam for a fast unit test.

---

## 7. Recommended implementation (synthesis)

1. Add an `onDidSaveTextDocument` listener storing `path → savedText` (normalized path key).
2. In **both** `onDiskChange` and `onDiskCreate`, replace `openDoc.getText() === diskContent` with:
   consume the save token for the path; absorb into baseline **iff** a token exists **and**
   normalized `diskContent === savedText`; otherwise `enterReviewing`.
3. **Delete** the `openDoc`/`getText()` comparison entirely — it is the defect and must not remain
   as a fallback. (`selfEditFiles` still handles the extension's own accept/reject writes.)
4. Normalize EOL + final newline before comparison.
5. Scope the save token so a save with no following disk-change can't later swallow an external edit.
6. Add tests A–F with an injected seam; make them timer-free.
7. Decide the dirty-buffer product behavior (§4.5) explicitly.
8. Separately: rule out `files.watcherExclude`/gitignore for any closed-file reports (§5), and fix
   the null-baseline silent snapshot (§5.5).

**Residual risk after the fix:** narrow — a save whose disk event is lost, and the rapid
same-file-churn window — both far smaller than the bug being replaced, and both testable.

---

---

## 8. What was implemented (2026-07-12)

**Code — [fileWatcher.ts](../src/fileWatcher.ts):**
- Added `onDidSaveTextDocument` listener recording `path → savedText` in `pendingManualSaves`.
- Added `consumeManualSave(path, diskContent)`: consume-once, **exact** content match. A user save
  is absorbed only when VSCode saved *exactly* the bytes now on disk; anything else falls through to
  review. Exact match is deliberate — it fails safe toward *reviewing*, so a stale token (a save with
  no following disk event) can only ever match no-op content, never swallow a real external edit.
- Replaced the fragile `openDoc.getText() === diskContent` heuristic in **both** `onDiskChange` and
  `onDiskCreate` with `consumeManualSave`. The buffer comparison is gone entirely.
- Added entry + per-branch **logging** to `onDiskChange` (it previously logged nothing), including a
  loud line on the Cause B silent-absorb path so future misses are findable in the output channel.

**Tests — [saveVsExternalEdit.test.ts](../src/test/integration/saveVsExternalEdit.test.ts):**
drive `onDiskChange` directly via the `getFileWatcher()` seam (no dependence on the flaky headless
watcher). Cases: external edit to an **open** file → reviewing + baseline preserved (the reported
bug); external edit to a **closed** tracked file → reviewing; genuine **manual save** → absorbed;
Cause B **characterization** test pinning current silent-absorb behavior with a "flip this assertion"
note.

**Not changed — Cause B decision pending.** The null-baseline silent snapshot (L467) is *intentional*
(avoids false "new file" hunks during enable / ignore-rule-change races) but also silently drops a
missed-create edit. Flipping it to `enterReviewing(null)` would recover those edits at the risk of
spurious hunks during transient enable states. Left as-is, now **logged**, with a characterization
test — a deliberate decision to make explicitly rather than change unilaterally.

---

*Panel: pragmatic senior engineer, VSCode extension API specialist, AI/agentic-tooling specialist,
QA/test-strategy specialist. Convened 2026-07-12.*
