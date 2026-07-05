import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { ReviewPanel } from './reviewPanel';
import { computeHunks, hunkId, ParsedHunk, splitHunkByRange } from './diffEngine';
import { FileState } from './types';
import { upsertGitignore } from './gitignoreManager';
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
  return hunks.find(h => line >= h.newStart && line < h.newStart + Math.max(1, h.newLines))
    ?? hunks.find(h => h.newStart >= line)
    ?? hunks[0];
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
  const pos = new vscode.Position(Math.max(0, hunk.newStart - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('interactiveReview.enable', () =>
      enableReview(stateManager, fileWatcher, reviewPanel, onStateChanged)
    ),
    vscode.commands.registerCommand('interactiveReview.disable', () =>
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
        await stateManager.setEnabled(true);
        try { upsertGitignore(); } catch (err) { log(`upsertGitignore failed: ${err}`); }
        // Re-read .gitignore synchronously so a gitignore file that existed before
        // enabling is honored by the snapshot below, rather than depending on the
        // async file watcher having already fired (unreliable on Linux).
        fileWatcher.reloadGitignore();
        await stateManager.snapshotWorkspace((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      })(),
    ]);
  } finally {
    reviewPanel.setLoading(false);
  }
  onStateChanged();
}

async function disableReview(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  log('disable');
  stateManager.setEnabled(false);
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
    } else if (fileState.baseline === '' && fs.existsSync(filePath)) {
      // Existed as empty file — restore to empty
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, '');
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    } else if (!fs.existsSync(filePath)) {
      // File was deleted — restore from baseline
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fileState.baseline ?? '', 'utf-8');
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } else {
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, fileState.baseline ?? '');
      await vscode.workspace.applyEdit(edit);
      await doc.save();
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

  const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
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

  const remainingHunks = computeHunks(newBaseline, doc.getText());
  log(`acceptHunk(${basename}): remainingHunks=${remainingHunks.length}`);
  if (remainingHunks.length === 0) {
    log(`acceptHunk(${basename}): last hunk, exitReviewing`);
    stateManager.exitReviewing(filePath, doc.getText());
  } else {
    stateManager.setFile(filePath, { status: 'reviewing', baseline: newBaseline });
    revealNextHunk(filePath, remainingHunks, originalNewStart);
  }
  onStateChanged();
  log(`acceptHunk(${basename}): done`);
}

/** Reveal the next hunk in the editor after an accept/discard operation. */
function revealNextHunk(filePath: string, remainingHunks: ReturnType<typeof computeHunks>, originalNewStart: number): void {
  const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);
  if (!editor) return;

  // Find the first remaining hunk at or after the original position
  const next = remainingHunks.find(h => h.newStart >= originalNewStart) ?? remainingHunks[0];
  if (!next) return;

  const pos = new vscode.Position(Math.max(0, next.newStart - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
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
    const saved = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
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

  const fileState = stateManager.getFile(filePath);
  if (!fileState) { log(`rejectSelection(${basename}): no fileState, skip`); return; }

  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const allHunks = computeHunks(fileState.baseline, doc.getText());
  log(`rejectSelection(${basename}): total hunks=${allHunks.length}`);

  // Resolve the hunk at the selection start (1-based), mirroring hunkAtCursor.
  const startLine1 = selStartLine + 1;
  const hunk = allHunks.find(h => startLine1 >= h.newStart && startLine1 < h.newStart + Math.max(1, h.newLines))
    ?? allHunks.find(h => h.newStart >= startLine1);
  if (!hunk) { log(`rejectSelection(${basename}): no hunk at selection, skip`); return; }

  // Never a silent partial success: log when the selection reaches into other hunks.
  const endLine1 = selEndLine + 1;
  const intersected = allHunks.filter(h => {
    const hStart = h.newStart;
    const hEnd = h.newStart + Math.max(1, h.newLines) - 1;
    return endLine1 >= hStart && startLine1 <= hEnd;
  });
  if (intersected.length > 1) {
    log(`rejectSelection(${basename}): selection spans ${intersected.length} hunks; resolving the hunk at selection start only, ignoring ${intersected.length - 1} other(s)`);
  }

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

