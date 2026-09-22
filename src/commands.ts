import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { ReviewPanel } from './reviewPanel';
import { computeHunks, hunkAtLine, hunkId, ParsedHunk, splitHunkByRange } from './diffEngine';
import {
  acceptHunkBaseline, acceptLinesBaseline, discardHunkText, minimalSplice, rejectLinesText,
} from './hunkApply';
import { restoreDiffSettings } from './diffSettings';
import { FileState } from './types';
import { findFileDocument, findFileEditor, revealHunkPosition } from './editorUtils';
import { bomFromFile, readTextFileSync, stripBom, withBomFrom } from './textFile';
import { log } from './log';

/**
 * Delete a file the user is discarding, to the OS trash rather than permanently.
 *
 * Discarding the last hunk of an agent-created *new* file removes it from disk. That is
 * the only operation in the extension whose effect an undo cannot reach: accept and
 * reject both go through a `WorkspaceEdit` and live on the editor's undo stack, but an
 * unlinked file has no buffer left to undo into. One keystroke on a mis-aimed lens
 * therefore destroyed content the agent had just written, silently and for good.
 *
 * `useTrash` moves the decision from irreversible to recoverable at the cost of nothing:
 * the file still leaves the workspace and still leaves review. Where a trash is
 * unavailable (some remote/container filesystems) VS Code rejects the request, so the
 * caller falls back to a permanent delete rather than leaving the file stranded in the
 * queue — the outcome is then no worse than before this existed.
 */
async function deleteDiscardedFile(filePath: string, label: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
    log(`${label}(${path.basename(filePath)}): discarded new file moved to trash`);
  } catch (err) {
    log(`${label}(${path.basename(filePath)}): trash delete failed (${err}), falling back to unlink`);
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    } catch (err2) {
      log(`${label}(${path.basename(filePath)}): delete failed: ${err2}`);
    }
  }
}

/**
 * Does discarding this file mean deleting it from disk?
 *
 * Only for a file this session watched being created. A null baseline alone is not
 * enough — it is also what a pre-existing binary, a file unreadable at enable, and a
 * file created inside the enable snapshot's sliver all carry, and deleting one of those
 * destroys content the user had before review began. `nullReason` is the discriminator
 * and absent reads as "do not delete"; see `FileState.nullReason`.
 *
 * For the non-deleting null case there is simply nothing to restore — no baseline
 * exists — so discard drops the file from the queue and leaves the bytes alone.
 */
function discardDeletesFile(fileState: FileState): boolean {
  return fileState.baseline === null && fileState.nullReason === 'created';
}

// ── Cursor-based resolution for keyboard-driven review ─────────────────────────
// Keybindings carry no arguments, so accept/reject/navigate commands resolve their
// target from the active editor and cursor position rather than a hunk id.

/** The active editor, if it is a file currently being reviewed. */
export function activeReviewTarget(stateManager: StateManager):
  { editor: vscode.TextEditor; filePath: string; fileState: FileState } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return undefined;
  const filePath = editor.document.uri.fsPath;
  const fileState = stateManager.getFile(filePath);
  if (!fileState || fileState.status !== 'reviewing') return undefined;
  return { editor, filePath, fileState };
}

/** Pending hunk containing the cursor, else the first hunk at/after it, else the first. */
export function hunkAtCursor(editor: vscode.TextEditor, fileState: FileState): ParsedHunk | undefined {
  const hunks = computeHunks(fileState.baseline, editor.document.getText());
  if (hunks.length === 0) return undefined;
  const line = editor.selection.active.line + 1; // computeHunks newStart is 1-based
  // Cursor navigation always lands on a hunk, so wrap to the first when the cursor sits
  // past every hunk — the `?? hunks[0]` that selection commands deliberately omit.
  return hunkAtLine(hunks, line) ?? hunks[0];
}

/** Neighbouring pending hunk for keyboard navigation (dir 1 = next, -1 = previous). */
export function neighbourHunk(editor: vscode.TextEditor, fileState: FileState, dir: 1 | -1): ParsedHunk | undefined {
  const hunks = computeHunks(fileState.baseline, editor.document.getText());
  if (hunks.length === 0) return undefined;
  const line = editor.selection.active.line + 1;
  if (dir === 1) return hunks.find(h => h.newStart > line);
  const before = hunks.filter(h => h.newStart < line);
  return before.length ? before[before.length - 1] : undefined;
}

/** Move the cursor to a hunk and center it in view. */
export function revealHunk(editor: vscode.TextEditor, hunk: ParsedHunk): void {
  revealHunkPosition(editor, hunk.newStart);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('interactiveReview.beginReview', () =>
      enableReview(stateManager, fileWatcher, reviewPanel, onStateChanged)
    ),
    vscode.commands.registerCommand('interactiveReview.endReview', () =>
      disableReview(stateManager, context.globalState, onStateChanged)
    ),
    vscode.commands.registerCommand('interactiveReview.setIgnorePatterns', async (patterns: string[]) => {
      stateManager.setIgnorePatterns(patterns);
      onStateChanged();
      await stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      onStateChanged();
    }),
    vscode.commands.registerCommand('interactiveReview.setRespectGitignore', async (value: boolean) => {
      stateManager.setRespectGitignore(value);
      onStateChanged();
      await stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      onStateChanged();
    }),
    vscode.commands.registerCommand('interactiveReview.setClearOnBranchSwitch', (value: boolean) => {
      stateManager.setClearOnBranchSwitch(value);
    }),
    vscode.commands.registerCommand('interactiveReview.clearHunks', async () => {
      await stateManager.clearHunksOnBranchSwitch(
        (fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)
      );
      onStateChanged();
    }),
  );
}

/**
 * The Begin review currently running, if any. Module-scoped because the command is
 * registered once and can be invoked concurrently from the palette, the panel button and an
 * agent. See the first guard in `enableReview`.
 */
let beginInFlight: Promise<void> | undefined;

/**
 * Begin a review session: snapshot the working tree as the baseline and start tracking.
 * Backs the `interactiveReview.beginReview` command ("Begin review" in the palette).
 *
 * The ID was renamed from `interactiveReview.enable` — a deliberate breaking change, so
 * that the command id, the palette title, and the panel button all say the same thing.
 * Anything pinning the old id (user keybindings, external/agent callers) must be updated.
 *
 * This is the **agent-callable begin-review hook**, and that imposes a contract worth
 * keeping: it must stay non-interactive. No dialogs, no quick-picks, no dependence on the
 * panel being visible (`setLoading` no-ops when the view is unresolved), and the returned
 * promise must not resolve until the snapshot is complete — an agent that awaits
 * `executeCommand('interactiveReview.beginReview')` and then starts editing relies on the
 * baseline already being on disk. Adding a prompt here silently breaks agent-driven review.
 *
 * The 750ms leg of the `Promise.all` is a *floor* on the splash duration, not a timeout:
 * both legs are awaited, so a slower snapshot still completes before this resolves.
 */
export async function enableReview(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): Promise<void> {
  log('enable');
  // A Begin review that is still running is joined, not refused.
  //
  // This check must come FIRST, because `setEnabled` flips `enabled` synchronously before
  // its first await — so from the moment the first Begin starts, the guard below already
  // sees an open session. Without this, a second Begin arriving mid-snapshot returned
  // immediately, while no baseline was on disk yet. That breaks the contract this command
  // exists to keep: an agent awaits Begin review and starts editing, and those edits land
  // on files that were never baselined. Two agents, or an agent and the panel button, are
  // enough to hit it.
  //
  // Awaiting the in-flight promise gives the second caller the same guarantee as the first,
  // including the same failure.
  if (beginInFlight) {
    log('enable: a Begin review is already in progress, awaiting it');
    return beginInFlight;
  }
  // Refuse to re-enter an *established* session. `snapshotWorkspace` re-snapshots every file
  // regardless of whether it already has a baseline, so a second Begin review silently
  // replaces every stored baseline with current disk content — git then holds the edits as
  // the baseline while memory still holds the originals, and the next Refresh empties the
  // queue of work the user never dispositioned. The command is always enabled in the
  // palette, so this was one mis-click away.
  //
  // Returning early rather than restarting keeps the agent contract intact: a caller that
  // awaits this still gets "a session is open and baselines are on disk" when it resolves.
  if (stateManager.enabled) {
    log('enable: a review session is already open, ignoring');
    void vscode.window.showInformationMessage(
      'Interactive Review: a review session is already running. End it first to start a new one.'
    );
    return;
  }
  // Assigned synchronously, before the first await, so a Begin arriving on any later tick
  // sees it. Cleared in `finally` so a failed Begin can be retried.
  beginInFlight = runBeginReview(stateManager, fileWatcher, reviewPanel, onStateChanged);
  try {
    await beginInFlight;
  } finally {
    beginInFlight = undefined;
  }
}

/**
 * The body of `enableReview`, split out so the in-flight promise above is created by a
 * single synchronous call.
 *
 * Reports its own failure. Every path in here ends with no usable baseline, and the caller
 * that matters most is an agent which is about to start editing — so this both tells the
 * user and rejects, rather than resolving as if the session were ready.
 */
async function runBeginReview(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): Promise<void> {
  reviewPanel.setLoading(true);
  try {
    await Promise.all([
      new Promise(resolve => setTimeout(resolve, 750)),
      (async () => {
        // Raised before `setEnabled` rather than just around `snapshotWorkspace`: the
        // watcher starts delivering events the moment `enabled` flips, and a create that
        // lands in the gap before the snapshot begins is every bit as pre-existing as one
        // that lands during it.
        fileWatcher.beginSnapshot();
        try {
          await stateManager.setEnabled(true);
          // The state dir gitignores itself (BaselineGit.ensureGitignore writes a
          // `*` rule inside .vscode/interactive-review/ on first write), so review
          // state stays out of the project's git without touching the user's files.
          // Re-read .gitignore synchronously so a gitignore file that existed before
          // enabling is honored by the snapshot below, rather than depending on the
          // async file watcher having already fired (unreliable on Linux).
          fileWatcher.reloadGitignore();
          await stateManager.snapshotWorkspace((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
          // A create adopted by the watcher during the window enqueues its git write
          // behind the snapshot's, so the snapshot returning does not mean every baseline
          // is on disk. Drain before resolving, or the contract above ("the baseline is
          // already on disk when this resolves") is false for exactly the files this
          // window exists to protect — and the agent's first edit to one of them lands on
          // an undefined baseline and gets silently absorbed.
          //
          // Draining `gitQueue` alone does not achieve that: an adopter reaches the queue
          // only after a disk read and a git read, so `flush` can capture a tail that does
          // not yet include it. Settle the handlers first, then flush — and repeat, because
          // awaiting either one gives newly arrived creates time to start. A pass that
          // waited on no handler proves none could have enqueued since, which makes the
          // flush that follows it authoritative and ends the loop.
          //
          // Bounded rather than `while (true)`: under a process that creates files
          // continuously (an `npm install` racing Begin review) there may be no quiet
          // moment, and blocking enable indefinitely is worse than the residual sliver
          // already documented in `handleDiskCreate`.
          const MAX_DRAIN_PASSES = 5;
          for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
            const settled = await fileWatcher.settleSnapshotCreates();
            await stateManager.flush();
            if (settled === 0) break;
            if (pass === MAX_DRAIN_PASSES - 1) {
              log(`enable: creates still arriving after ${MAX_DRAIN_PASSES} drain passes; proceeding`);
            }
          }
        } finally {
          fileWatcher.endSnapshot();
        }
      })(),
    ]);
  } catch (err) {
    log(`enable: failed — ${err}`);
    // Close the half-open session. `setEnabled(true)` flips `enabled` before anything that
    // can fail, and left open, the retry an agent makes next hits the "already open" guard
    // in `enableReview` and *resolves* — reporting baselines on disk that were never
    // written. Tearing down makes a plain retry work, for an agent and a user alike.
    // Guarded by `beginReview.test.ts` ("a failed Begin review can be retried").
    await stateManager.setEnabled(false).catch(e => log(`enable: teardown after failure failed — ${e}`));
    void vscode.window.showErrorMessage(
      'Interactive Review: Begin review failed, so no baseline was recorded and the session ' +
      `was closed. Run "Interactive Review: Begin review" again to retry. (${err})`
    );
    throw err;
  } finally {
    // Both in `finally`: the panel must leave its loading state and the UI must reflect
    // whatever state the failed attempt left behind, not stay frozen mid-enable.
    reviewPanel.setLoading(false);
    onStateChanged();
  }
}

/**
 * End the review session: clear tracked state and tear down the baseline snapshot. Backs
 * `interactiveReview.endReview` ("End review"), renamed from `interactiveReview.disable`.
 * Non-interactive for the same reason as `enableReview` — an agent closes the session it
 * opened.
 */
async function disableReview(
  stateManager: StateManager,
  globalState: vscode.Memento,
  onStateChanged: () => void
): Promise<void> {
  log('disable');
  // Awaited: the disable branch drains queued baseline writes before deleting the repo,
  // and callers await this command expecting teardown to be finished when it resolves.
  await stateManager.setEnabled(false);
  // Hand the user's global diffEditor settings back now that no review surface needs
  // them forced (ADR-0003). Session-scoped, so this is the natural restore point.
  await restoreDiffSettings(globalState);
  onStateChanged();
}

export async function acceptAllFiles(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  for (const filePath of Array.from(stateManager.getAllFiles().keys())) {
    acceptFileByPath(stateManager, filePath, () => {});
  }
  onStateChanged();
}

/**
 * The question Discard All asks before it runs, or undefined when there is nothing to
 * discard. Counts each outcome `discardFileByPath` will actually produce, and names deletes
 * separately because a deleted file is the one outcome the user cannot get back by editing
 * (it goes to the trash, if there is one).
 */
export function discardAllPrompt(
  files: Iterable<[string, FileState]>,
  exists: (filePath: string) => boolean = fs.existsSync,
): string | undefined {
  let reverted = 0;
  let deleted = 0;
  let kept = 0;
  for (const [filePath, f] of files) {
    if (f.status !== 'reviewing') continue;
    if (discardDeletesFile(f)) {
      // Already gone from disk: discarding only drops the entry.
      if (exists(filePath)) deleted++; else kept++;
    } else if (f.baseline === null) {
      // Predates the session with no saved original: left as it is (`keepsUnbaselinedFile`).
      kept++;
    } else {
      reverted++;
    }
  }
  if (reverted + deleted + kept === 0) return undefined;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (reverted > 0) parts.push(`revert ${plural(reverted, 'file')} to the start of the review`);
  if (deleted > 0) parts.push(`delete ${plural(deleted, 'new file')}`);
  if (kept > 0) parts.push(`stop reviewing ${plural(kept, 'file')} it cannot revert, leaving ${kept === 1 ? 'it' : 'them'} as ${kept === 1 ? 'it is' : 'they are'}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `Discard all pending changes? This will ${list}.`;
}

/**
 * Discard All from the panel button: ask, then discard exactly the files the question
 * counted. One click there rewrites every file in the queue, so it needs the guard, while
 * `discardAllFiles` itself stays dialog-free for tests and programmatic callers.
 *
 * The paths are snapshotted before the modal opens. It can stay up indefinitely while an
 * agent keeps writing, and re-reading the queue after the answer would discard — possibly
 * delete — files the user was never told about. Returns whether anything was discarded.
 */
export async function confirmAndDiscardAll(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void,
): Promise<boolean> {
  const entries = Array.from(stateManager.getAllFiles().entries());
  const prompt = discardAllPrompt(entries);
  if (!prompt) return false;
  const choice = await vscode.window.showWarningMessage(prompt, { modal: true }, 'Discard All');
  if (choice !== 'Discard All') {
    log('discardAll: not confirmed, skipping');
    return false;
  }
  await discardAllFiles(stateManager, fileWatcher, onStateChanged, entries.map(([fp]) => fp));
  return true;
}

export async function discardAllFiles(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void,
  /** Restrict to these files; defaults to the whole queue. Entries resolved since are skipped. */
  only?: readonly string[],
): Promise<void> {
  for (const filePath of only ?? Array.from(stateManager.getAllFiles().keys())) {
    try {
      await discardFileByPath(stateManager, fileWatcher, filePath, () => {});
    } catch (err) { log(`discardAllFiles: failed to restore ${filePath}: ${err}`); }
  }
  onStateChanged();
}

export function acceptFileByPath(
  stateManager: StateManager,
  filePath: string,
  onStateChanged: () => void
): void {
  if (!stateManager.getFile(filePath)) return;
  const basename = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    // File was deleted — remove from tracking entirely
    log(`acceptFileByPath(${basename}): file not on disk, removeFile`);
    stateManager.removeFile(filePath);
  } else {
    // File exists (possibly empty) — accept current content as new baseline.
    const content = readTextFileSync(filePath);
    if (content === null) {
      // Binary. `fs.readFile(…, 'utf-8')` would happily hand back a replacement-character
      // decoding of it, and storing that as a baseline arms a later discard to write the
      // mush over the real bytes. Accept it out of the queue with no baseline instead:
      // the file is accepted either way, and nothing exists afterwards to restore from.
      log(`acceptFileByPath(${basename}): binary, accepting with no baseline`);
      stateManager.removeFile(filePath);
    } else {
      log(`acceptFileByPath(${basename}): file exists, exitReviewing with content.len=${content.length}`);
      stateManager.exitReviewing(filePath, content);
    }
  }
  onStateChanged();
}

/**
 * Replace the entire contents of an on-disk document with `content` and save.
 * Uses a full-range WorkspaceEdit (rather than fs.writeFileSync) so that an open
 * editor for the file reflects the change immediately instead of prompting to
 * reload from disk.
 */
async function replaceEntireDocument(uri: vscode.Uri, content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
  );
  edit.replace(uri, fullRange, content);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

export async function discardFileByPath(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  onStateChanged: () => void
): Promise<void> {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  fileWatcher.markSelfEdit(filePath);
  try {
    if (discardDeletesFile(fileState)) {
      // New file (didn't exist before) — delete it, recoverably.
      if (fs.existsSync(filePath)) {
        await deleteDiscardedFile(filePath, 'discardFileByPath');
      }
    } else if (fileState.baseline === null) {
      // Null baseline but the file predates the session — nothing to restore to and
      // nothing we may delete. Leave the bytes untouched; the drop below clears the queue.
      log(`discardFileByPath(${path.basename(filePath)}): unbaselined file, leaving on disk`);
    } else if (!fs.existsSync(filePath)) {
      // File was deleted — restore from baseline
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fileState.baseline, 'utf-8');
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } else {
      // File exists (possibly empty) — restore its contents to the baseline.
      await replaceEntireDocument(vscode.Uri.file(filePath), stripBom(fileState.baseline));
    }
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
  if (discardDeletesFile(fileState)) {
    // Discarding a new file means it was deleted — remove from tracking
    stateManager.removeFile(filePath);
  } else if (fileState.baseline === null) {
    // The file stays as it is, which is what accepting it does — including taking its
    // content as the baseline. Only removing the entry left nothing a rescan could read, so
    // a Refresh or a window reload put the file back in the queue. Guarded by
    // `reloadEqualsMemory.test.ts` ("discarding an unbaselined file").
    try {
      acceptFileByPath(stateManager, filePath, () => {});
    } catch (err) {
      // Unreadable now (permissions, or deleted since the check). Drop the entry as before
      // rather than throw: `discardAllFiles` would stop at this file and leave the rest.
      log(`discardFileByPath(${path.basename(filePath)}): could not read to record a baseline (${err}), dropping the entry`);
      stateManager.removeFile(filePath);
    }
  } else {
    stateManager.exitReviewing(filePath);
  }
  onStateChanged();
}


export function acceptHunk(
  stateManager: StateManager,
  filePath: string,
  id: string,
  onStateChanged: () => void,
  source: string = 'unknown'
): void {
  const basename = path.basename(filePath);
  log(`acceptHunk(${basename}): hunkId=${id}, source=${source}`);

  const fileState = stateManager.getFile(filePath);
  if (!fileState) { log(`acceptHunk(${basename}): no fileState, skip`); return; }

  const doc = findFileDocument(filePath);
  if (!doc) { log(`acceptHunk(${basename}): no doc found, skip`); return; }
  if (refusesDirtyAccept(doc, 'acceptHunk')) return;
  // `?? bomFromFile` rather than `?? ''`: a null baseline has no marker to carry, so for a
  // new BOM'd file the disk is the only witness. Seeding it here means every baseline built
  // below — the partial one and the final one alike — inherits it through `withBomFrom`.
  const baselineStr = fileState.baseline ?? bomFromFile(filePath);
  log(`acceptHunk(${basename}): doc.scheme=${doc.uri.scheme}, doc.len=${doc.getText().length}, baseline.len=${baselineStr.length}`);

  const hunks = computeHunks(fileState.baseline, doc.getText());
  log(`acceptHunk(${basename}): total hunks=${hunks.length}`);
  const hunk = hunks.find(h => hunkId(h) === id);
  if (!hunk) { log(`acceptHunk(${basename}): hunk not found, skip`); return; }

  const originalNewStart = hunk.newStart;

  // Stripped on the way in, so line 1 lines up with the buffer's line 1 (and with
  // `computeHunks`, which strips both sides); `withBomFrom` puts the marker back on the
  // baseline we store. The splice itself lives in `hunkApply`, which tracks the trailing
  // newline as a flag rather than as an array element — see that module for the bug this
  // arrangement fixed on both sides of the diff.
  const newBaseline = withBomFrom(
    baselineStr,
    acceptHunkBaseline(stripBom(baselineStr), doc.getText(), hunk),
  );

  finishBaselineAdvance(stateManager, filePath, newBaseline, doc, originalNewStart, onStateChanged, 'acceptHunk');
}

/**
 * Refuse a hunk-level accept while the file has unsaved edits, and say why.
 *
 * Accept folds the *buffer* into the baseline, but a rescan rebuilds from *disk*. With
 * unsaved edits the baseline would hold text the file does not contain, and the next Refresh
 * or window reload would queue the file again with a hunk undoing text that was never saved.
 * File-level Accept reads disk and is unaffected. The proper fix is to save first, which
 * makes these commands async; see `todo.md` item D. Guarded by `reviewCommands.test.ts`
 * ("refuses to accept a hunk while the file has unsaved edits").
 */
function refusesDirtyAccept(doc: vscode.TextDocument, label: string): boolean {
  if (!doc.isDirty) return false;
  const basename = path.basename(doc.uri.fsPath);
  log(`${label}(${basename}): buffer has unsaved edits, refusing`);
  void vscode.window.showWarningMessage(
    `Interactive Review: save ${basename} before accepting. Its unsaved edits are not on disk yet.`,
  );
  return true;
}

/** Reveal the next hunk in the editor after an accept/discard operation. */
function revealNextHunk(filePath: string, remainingHunks: ReturnType<typeof computeHunks>, originalNewStart: number): void {
  const editor = findFileEditor(filePath);
  if (!editor) return;

  // Find the first remaining hunk at or after the original position
  const next = remainingHunks.find(h => h.newStart >= originalNewStart) ?? remainingHunks[0];
  if (!next) return;

  revealHunkPosition(editor, next.newStart);
}

/**
 * Shared tail of `acceptHunk`/`acceptSelection`: after the caller has folded the accepted
 * change into `newBaseline`, re-diff against the live document and advance the walk. When
 * nothing remains, exit reviewing; otherwise persist the new baseline and reveal the next
 * hunk at/after `originalNewStart`. A pure sink — the caller owns baseline computation.
 * `label` names the caller for logging.
 */
function finishBaselineAdvance(
  stateManager: StateManager,
  filePath: string,
  newBaseline: string,
  doc: vscode.TextDocument,
  originalNewStart: number,
  onStateChanged: () => void,
  label: string,
): void {
  const basename = path.basename(filePath);
  const remainingHunks = computeHunks(newBaseline, doc.getText());
  log(`${label}(${basename}): remainingHunks=${remainingHunks.length}`);
  if (remainingHunks.length === 0) {
    log(`${label}(${basename}): last change, exitReviewing`);
    // The buffer is the right *content* for the new baseline (it carries the user's EOLs
    // and every accepted line) and the wrong *encoding* for it: VS Code strips the BOM on
    // the way into a document and re-adds it on save, so `doc.getText()` never has one
    // while `newBaseline` does. Storing the buffer verbatim would drop the marker on the
    // single-hunk accept — the common path — and a later restore from that baseline would
    // write the file back without it. See ADR-0013: normalize at comparison, not storage.
    stateManager.exitReviewing(filePath, withBomFrom(newBaseline, doc.getText()));
  } else {
    stateManager.setFile(filePath, { status: 'reviewing', baseline: newBaseline });
    revealNextHunk(filePath, remainingHunks, originalNewStart);
  }
  onStateChanged();
  log(`${label}(${basename}): done`);
}

/**
 * Apply a prepared WorkspaceEdit to a reviewing file under the self-edit guard, then
 * recompute the pending hunks and advance the walk: when nothing remains, exit reviewing
 * (deleting a fully-discarded new file from disk); otherwise reveal the next hunk. Shared
 * by `discardHunk` and `rejectSelection` so the resolve-and-advance behaviour stays in one
 * place. `label` names the caller for logging.
 */
async function applyEditAndAdvance(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  fileState: FileState,
  doc: vscode.TextDocument,
  edit: vscode.WorkspaceEdit,
  originalNewStart: number,
  onStateChanged: () => void,
  label: string
): Promise<void> {
  const basename = path.basename(filePath);
  fileWatcher.markSelfEdit(filePath);
  try {
    const applied = await vscode.workspace.applyEdit(edit);
    log(`${label}(${basename}): applyEdit=${applied}`);
    if (!applied) {
      log(`${label}(${basename}): applyEdit failed, aborting`);
      return;
    }
    const saved = findFileDocument(filePath);
    if (saved) await saved.save();
    const currentText = saved?.getText() ?? doc.getText();
    const remainingHunks = computeHunks(fileState.baseline, currentText);
    log(`${label}(${basename}): remainingHunks=${remainingHunks.length}`);
    if (remainingHunks.length === 0) {
      if (discardDeletesFile(fileState) && fs.existsSync(filePath)) {
        // New file (didn't exist before) fully discarded — remove from disk, recoverably.
        // An unbaselined file never gets here: see `keepsUnbaselinedFile`.
        log(`${label}(${basename}): new file fully discarded, deleting`);
        await deleteDiscardedFile(filePath, label);
      }
      log(`${label}(${basename}): no hunks left, exitReviewing`);
      stateManager.exitReviewing(filePath);
    } else {
      revealNextHunk(filePath, remainingHunks, originalNewStart);
    }
    onStateChanged();
    log(`${label}(${basename}): done`);
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
}

/**
 * Hunk-level Discard and reject on an unbaselined file: resolve the whole file the way
 * `discardFileByPath` does, and return true so the caller stops.
 *
 * The file predates the session and there is no baseline to restore it to, so its one
 * whole-file hunk has no "before" but `''`. Splicing towards that emptied the file, or
 * deleted the selected lines, which is the user's own content; and exiting review without a
 * baseline let the next Refresh queue it again. File-level Discard keeps the bytes and
 * records them. Guarded by `deleteRestore.test.ts` ("discarding the hunk of an unbaselined
 * file") and see `todo.md` item G.
 */
async function keepsUnbaselinedFile(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  fileState: FileState,
  onStateChanged: () => void,
  label: string
): Promise<boolean> {
  if (fileState.baseline !== null || discardDeletesFile(fileState)) return false;
  log(`${label}(${path.basename(filePath)}): unbaselined file, nothing to restore — keeping it as a file-level discard`);
  await discardFileByPath(stateManager, fileWatcher, filePath, onStateChanged);
  return true;
}

export async function discardHunk(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  id: string,
  onStateChanged: () => void,
  source: string = 'unknown'
): Promise<void> {
  const basename = path.basename(filePath);
  log(`discardHunk(${basename}): hunkId=${id}, source=${source}`);

  const fileState = stateManager.getFile(filePath);
  if (!fileState) { log(`discardHunk(${basename}): no fileState, skip`); return; }
  if (await keepsUnbaselinedFile(stateManager, fileWatcher, filePath, fileState, onStateChanged, 'discardHunk')) return;

  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  const allHunks = computeHunks(fileState.baseline, doc.getText());
  log(`discardHunk(${basename}): total hunks=${allHunks.length}`);
  const hunk = allHunks.find(h => hunkId(h) === id);
  if (!hunk) { log(`discardHunk(${basename}): hunk not found, skip`); return; }

  const originalNewStart = hunk.newStart;

  const baselineStr = fileState.baseline ?? '';
  // Stripped because this text goes into the *document*: VS Code re-adds the file's own
  // BOM on save, so a carried one would land on disk as a second BOM.
  //
  // The edit is derived from the whole desired text rather than built out of hunk
  // coordinates. Constructing the range by hand is what produced the defect this replaces:
  // the replacement always ended in a newline and the range stopped short of the document's
  // last line, so discarding a hunk at EOF in a file with no final newline *added* one —
  // leaving a hunk that could never be resolved, no matter how many times it was discarded.
  const currentText = doc.getText();
  const desiredText = discardHunkText(stripBom(baselineStr), currentText, hunk);
  const splice = minimalSplice(currentText, desiredText);
  if (splice.startOffset === splice.endOffset && splice.replacement === '') {
    // Cannot happen for a hunk that genuinely exists — `hunkApply`'s property test asserts
    // every discard changes the text — so treat it as a stale hunk id rather than applying
    // a no-op edit and reporting success.
    log(`discardHunk(${basename}): discard would be a no-op, skip`);
    return;
  }
  const range = new vscode.Range(doc.positionAt(splice.startOffset), doc.positionAt(splice.endOffset));
  log(`discardHunk(${basename}): replacing lines ${range.start.line}-${range.end.line}`);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, splice.replacement);
  await applyEditAndAdvance(stateManager, fileWatcher, filePath, fileState, doc, edit, originalNewStart, onStateChanged, 'discardHunk');
}

/**
 * Shared head of `acceptSelection`/`rejectSelection`: guard fileState, open the file, diff
 * it, resolve the hunk at the selection start, and log a multi-hunk overreach. Returns the
 * resolved `{ doc, hunk, allHunks }`, or undefined when there is nothing to act on (no
 * fileState, or the selection sits past every hunk) — in which case the caller returns.
 *
 * Only the head is shared: the paths diverge sharply afterwards (accept folds lines into the
 * baseline without touching the buffer; reject deletes lines from the buffer), so the split
 * and its fallbacks stay in each caller. `label` names the caller for logging.
 */
async function resolveSelectionHunk(
  stateManager: StateManager,
  filePath: string,
  selStartLine: number,
  selEndLine: number,
  label: string,
): Promise<{ doc: vscode.TextDocument; hunk: ParsedHunk; fileState: FileState } | undefined> {
  const basename = path.basename(filePath);

  const fileState = stateManager.getFile(filePath);
  if (!fileState) { log(`${label}(${basename}): no fileState, skip`); return undefined; }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const allHunks = computeHunks(fileState.baseline, doc.getText());
  log(`${label}(${basename}): total hunks=${allHunks.length}`);

  // Resolve the hunk at the selection start (1-based) via the shared primitive.
  const startLine1 = selStartLine + 1;
  const hunk = hunkAtLine(allHunks, startLine1);
  if (!hunk) { log(`${label}(${basename}): no hunk at selection, skip`); return undefined; }

  // Never a silent partial success: log when the selection reaches into other hunks.
  const endLine1 = selEndLine + 1;
  const intersected = allHunks.filter(h => {
    const hStart = h.newStart;
    const hEnd = h.newStart + Math.max(1, h.newLines) - 1;
    return endLine1 >= hStart && startLine1 <= hEnd;
  });
  if (intersected.length > 1) {
    log(`${label}(${basename}): selection spans ${intersected.length} hunks; resolving the hunk at selection start only, ignoring ${intersected.length - 1} other(s)`);
  }

  return { doc, hunk, fileState };
}

/**
 * Reject only the added lines within a line selection that fall inside a pending hunk,
 * leaving the rest of the hunk pending. Reverting an added line means deleting it (it was
 * not in the baseline), so this deletes the selected added lines from the document and
 * recomputes against the unchanged baseline — deterministic, no baseline reconstruction.
 *
 * Fallbacks: a pure-removal hunk (no added lines) delegates to whole-hunk `discardHunk`;
 * a selection covering no added lines is a logged no-op; a selection spanning multiple
 * hunks resolves the hunk at the selection start only and logs that the rest are ignored.
 *
 * `selStartLine` / `selEndLine` are 0-based document line numbers (editor selection).
 */
export async function rejectSelection(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  selStartLine: number,
  selEndLine: number,
  onStateChanged: () => void,
  source: string = 'unknown'
): Promise<void> {
  const basename = path.basename(filePath);
  log(`rejectSelection(${basename}): sel=${selStartLine}-${selEndLine}, source=${source}`);

  const resolved = await resolveSelectionHunk(stateManager, filePath, selStartLine, selEndLine, 'rejectSelection');
  if (!resolved) return;
  const { doc, hunk, fileState } = resolved;
  const uri = doc.uri;
  if (await keepsUnbaselinedFile(stateManager, fileWatcher, filePath, fileState, onStateChanged, 'rejectSelection')) return;

  const split = splitHunkByRange(hunk, selStartLine, selEndLine);
  if (!split.hasAddedInRange) {
    if (hunk.newLines === 0) {
      log(`rejectSelection(${basename}): pure-removal hunk, falling back to whole-hunk reject`);
      await discardHunk(stateManager, fileWatcher, filePath, hunkId(hunk), onStateChanged, source);
    } else {
      log(`rejectSelection(${basename}): no added lines in range, no-op`);
    }
    return;
  }

  const originalNewStart = hunk.newStart;
  const delStart = hunk.newStart - 1 + split.addedStartIdx; // 0-based, inclusive
  const lastDel = hunk.newStart - 1 + split.addedEndIdx - 1; // 0-based, inclusive

  // Same whole-text derivation as `discardHunk`, and for the same reason: the end-of-file
  // cases (no trailing newline, deleting through the last line) are handled once in
  // `hunkApply` under test, rather than as a ladder of position arithmetic here.
  const currentText = doc.getText();
  const desiredText = rejectLinesText(stripBom(fileState.baseline ?? ''), currentText, hunk, delStart, lastDel);
  const splice = minimalSplice(currentText, desiredText);
  log(`rejectSelection(${basename}): deleting added lines ${delStart}-${lastDel}`);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(splice.startOffset), doc.positionAt(splice.endOffset)), splice.replacement);
  await applyEditAndAdvance(stateManager, fileWatcher, filePath, fileState, doc, edit, originalNewStart, onStateChanged, 'rejectSelection');
}

/**
 * Accept only the added lines within a line selection that fall inside a pending hunk,
 * folding them into the baseline and leaving the rest of the hunk pending. The symmetric
 * counterpart of `rejectSelection`. Accepting an added line means it stops being flagged
 * as a change: it is inserted into the baseline (at the hunk anchor) so
 * `computeHunks(newBaseline, buffer)` no longer reports it. Unlike reject this never edits
 * the buffer — the accepted content is already on disk; only the baseline advances forward,
 * exactly as whole-hunk `acceptHunk` does. Removed lines stay in the baseline (still pending
 * removal) and un-selected added lines stay pending, mirroring what a partial reject leaves.
 *
 * Fallbacks mirror `rejectSelection`: a pure-removal hunk (no added lines) delegates to
 * whole-hunk `acceptHunk`; a selection covering no added lines is a logged no-op; a
 * selection spanning multiple hunks resolves the hunk at the selection start only and logs
 * that the rest are ignored.
 *
 * `selStartLine` / `selEndLine` are 0-based document line numbers (editor selection).
 */
export async function acceptSelection(
  stateManager: StateManager,
  filePath: string,
  selStartLine: number,
  selEndLine: number,
  onStateChanged: () => void,
  source: string = 'unknown'
): Promise<void> {
  const basename = path.basename(filePath);
  log(`acceptSelection(${basename}): sel=${selStartLine}-${selEndLine}, source=${source}`);

  const resolved = await resolveSelectionHunk(stateManager, filePath, selStartLine, selEndLine, 'acceptSelection');
  if (!resolved) return;
  const { doc, hunk, fileState } = resolved;
  if (refusesDirtyAccept(doc, 'acceptSelection')) return;

  const split = splitHunkByRange(hunk, selStartLine, selEndLine);
  if (!split.hasAddedInRange) {
    if (hunk.newLines === 0) {
      log(`acceptSelection(${basename}): pure-removal hunk, falling back to whole-hunk accept`);
      acceptHunk(stateManager, filePath, hunkId(hunk), onStateChanged, source);
    } else {
      log(`acceptSelection(${basename}): no added lines in range, no-op`);
    }
    return;
  }

  const originalNewStart = hunk.newStart;
  // See `acceptHunk`: a null baseline carries no BOM, so seed it from disk.
  const baselineStr = fileState.baseline ?? bomFromFile(filePath);

  // Fold the selected added lines into the baseline at the hunk anchor — just after the
  // hunk's removed block (for a pure addition, oldLines === 0, so that is the insertion
  // point itself). The re-diff realigns the accepted lines as context while any surrounding
  // added lines and the still-present removed lines remain pending.
  const acceptStartLine = hunk.newStart - 1 + split.addedStartIdx;
  const acceptEndLine = hunk.newStart - 1 + split.addedEndIdx - 1;
  const newBaseline = withBomFrom(
    baselineStr,
    acceptLinesBaseline(stripBom(baselineStr), doc.getText(), hunk, acceptStartLine, acceptEndLine),
  );
  log(`acceptSelection(${basename}): folding ${acceptEndLine - acceptStartLine + 1} added line(s) into baseline`);

  finishBaselineAdvance(stateManager, filePath, newBaseline, doc, originalNewStart, onStateChanged, 'acceptSelection');
}

