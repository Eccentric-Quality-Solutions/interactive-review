import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { ReviewPanel } from './reviewPanel';
import { computeHunks, hunkAtLine, hunkId, ParsedHunk, splitHunkByRange } from './diffEngine';
import { FileState } from './types';
import { findFileDocument, findFileEditor, revealHunkPosition } from './editorUtils';
import { log } from './log';

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
      disableReview(stateManager, onStateChanged)
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
async function enableReview(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): Promise<void> {
  log('enable');
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
          await stateManager.flush();
        } finally {
          fileWatcher.endSnapshot();
        }
      })(),
    ]);
  } finally {
    reviewPanel.setLoading(false);
  }
  onStateChanged();
}

/**
 * End the review session: clear tracked state and tear down the baseline snapshot. Backs
 * `interactiveReview.endReview` ("End review"), renamed from `interactiveReview.disable`.
 * Non-interactive for the same reason as `enableReview` — an agent closes the session it
 * opened.
 */
async function disableReview(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  log('disable');
  // Awaited: the disable branch of setEnabled happens to run synchronously today, but
  // callers await this command expecting teardown to be finished when it resolves.
  await stateManager.setEnabled(false);
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

export async function discardAllFiles(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void
): Promise<void> {
  for (const [filePath] of Array.from(stateManager.getAllFiles().entries())) {
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
    // File exists (possibly empty) — accept current content as new baseline
    const content = fs.readFileSync(filePath, 'utf-8');
    log(`acceptFileByPath(${basename}): file exists, exitReviewing with content.len=${content.length}`);
    stateManager.exitReviewing(filePath, content);
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
    if (fileState.baseline === null) {
      // New file (didn't exist before) — delete it
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else if (!fs.existsSync(filePath)) {
      // File was deleted — restore from baseline
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fileState.baseline, 'utf-8');
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } else {
      // File exists (possibly empty) — restore its contents to the baseline.
      await replaceEntireDocument(vscode.Uri.file(filePath), fileState.baseline);
    }
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
  if (fileState.baseline === null) {
    // Discarding a new file means it was deleted — remove from tracking
    stateManager.removeFile(filePath);
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
  const baselineStr = fileState.baseline ?? '';
  log(`acceptHunk(${basename}): doc.scheme=${doc.uri.scheme}, doc.len=${doc.getText().length}, baseline.len=${baselineStr.length}`);

  const hunks = computeHunks(fileState.baseline, doc.getText());
  log(`acceptHunk(${basename}): total hunks=${hunks.length}`);
  const hunk = hunks.find(h => hunkId(h) === id);
  if (!hunk) { log(`acceptHunk(${basename}): hunk not found, skip`); return; }

  const originalNewStart = hunk.newStart;

  const currentLines = doc.getText().split('\n');
  const baselineLines = baselineStr.split('\n');
  const newBaseline = [
    ...baselineLines.slice(0, hunk.oldStart - 1),
    ...currentLines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines),
    ...baselineLines.slice(hunk.oldStart - 1 + hunk.oldLines),
  ].join('\n');

  finishBaselineAdvance(stateManager, filePath, newBaseline, doc, originalNewStart, onStateChanged, 'acceptHunk');
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
    stateManager.exitReviewing(filePath, doc.getText());
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
      if (fileState.baseline === null && fs.existsSync(filePath)) {
        // New file (didn't exist before) fully discarded — remove from disk
        log(`${label}(${basename}): new file fully discarded, deleting`);
        try { fs.unlinkSync(filePath); } catch (err) { log(`${label}(${basename}): unlink failed: ${err}`); }
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

  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  const allHunks = computeHunks(fileState.baseline, doc.getText());
  log(`discardHunk(${basename}): total hunks=${allHunks.length}`);
  const hunk = allHunks.find(h => hunkId(h) === id);
  if (!hunk) { log(`discardHunk(${basename}): hunk not found, skip`); return; }

  const originalNewStart = hunk.newStart;

  const baselineStr = fileState.baseline ?? '';
  const baselineLines = baselineStr.split('\n');
  const originalLines = baselineLines.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldLines);

  const startPos = new vscode.Position(hunk.newStart - 1, 0);
  let endPos: vscode.Position;
  if (hunk.newLines === 0) {
    endPos = startPos;
  } else {
    const lastNewLine = hunk.newStart - 1 + hunk.newLines - 1;
    endPos = lastNewLine < doc.lineCount - 1
      ? new vscode.Position(lastNewLine + 1, 0)
      : new vscode.Position(lastNewLine, doc.lineAt(lastNewLine).text.length);
  }

  const replacement = originalLines.length > 0 ? originalLines.join('\n') + '\n' : '';
  log(`discardHunk(${basename}): replacing lines ${startPos.line}-${endPos.line} with ${originalLines.length} original lines`);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(startPos, endPos), replacement);
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

  // Delete whole lines including their newline. When the slice runs to the final line of
  // the document there is no following newline to consume, so back the start up to the end
  // of the preceding line instead (mirrors discardHunk's end-of-file handling).
  let startPos: vscode.Position;
  let endPos: vscode.Position;
  if (lastDel < doc.lineCount - 1) {
    startPos = new vscode.Position(delStart, 0);
    endPos = new vscode.Position(lastDel + 1, 0);
  } else if (delStart > 0) {
    startPos = new vscode.Position(delStart - 1, doc.lineAt(delStart - 1).text.length);
    endPos = new vscode.Position(lastDel, doc.lineAt(lastDel).text.length);
  } else {
    startPos = new vscode.Position(0, 0);
    endPos = new vscode.Position(lastDel, doc.lineAt(lastDel).text.length);
  }
  log(`rejectSelection(${basename}): deleting added lines ${delStart}-${lastDel}`);

  const edit = new vscode.WorkspaceEdit();
  edit.delete(uri, new vscode.Range(startPos, endPos));
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
  const baselineLines = (fileState.baseline ?? '').split('\n');
  const currentLines = doc.getText().split('\n');

  // Fold the selected added lines into the baseline at the hunk anchor — just after the
  // hunk's removed block (for a pure addition, oldLines === 0, so that is the insertion
  // point itself). The re-diff realigns the accepted lines as context while any surrounding
  // added lines and the still-present removed lines remain pending.
  const acceptedLines = currentLines.slice(
    hunk.newStart - 1 + split.addedStartIdx,
    hunk.newStart - 1 + split.addedEndIdx,
  );
  const insertAt = hunk.oldStart - 1 + hunk.oldLines; // 0-based baseline line index
  const newBaseline = [
    ...baselineLines.slice(0, insertAt),
    ...acceptedLines,
    ...baselineLines.slice(insertAt),
  ].join('\n');
  log(`acceptSelection(${basename}): folding ${acceptedLines.length} added line(s) into baseline at ${insertAt}`);

  finishBaselineAdvance(stateManager, filePath, newBaseline, doc, originalNewStart, onStateChanged, 'acceptSelection');
}

