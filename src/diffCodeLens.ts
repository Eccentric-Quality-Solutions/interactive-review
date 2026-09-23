import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks, hunkId, lensLineForHunk } from './diffEngine';

export class DiffCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private stateManager: StateManager) {}

  fire(): void {
    this._onDidChangeCodeLenses.fire();
  }
  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.stateManager.enabled) return [];

    // A deleted file's modified side is an empty `interactive-review-deleted` doc
    // (no `file`-scheme doc for the hunk lenses below), so file-level Accept/Restore
    // actions are rendered there instead — see provideDeletedFileLenses.
    if (document.uri.scheme === 'interactive-review-deleted') {
      return this.provideDeletedFileLenses(document);
    }
    if (document.uri.scheme !== 'file') return [];

    const fileState = this.stateManager.getFile(document.uri.fsPath);
    if (!fileState || fileState.status !== 'reviewing') return [];

    // Render on the active review diff tab, and suppress when a normal editor is
    // also visible (split view) to avoid duplicate actions.
    if (!this.isActiveReviewDiffTab(document.uri)) return [];
    if (this.hasVisibleNormalEditor(document.uri)) return [];

    const hunks = computeHunks(fileState.baseline, document.getText());
    const lenses: vscode.CodeLens[] = [];

    for (const hunk of hunks) {
      // A CodeLens renders immediately *above* its anchor, so the anchor decides which
      // block the buttons appear to belong to. `lensLineForHunk` answers with the hunk's
      // first line and is property-tested in diffEngine.test.ts; anchoring anywhere past
      // the hunk puts the buttons above the *next* block, which with adjacent hunks means
      // clicking Accept resolves a hunk the user was not looking at.
      const line = lensLineForHunk(hunk, document.lineCount);
      const range = new vscode.Range(line, 0, line, 0);
      const id = hunkId(hunk);
      // State the extent on the button, so a one-line tweak and a thirteen-line deletion
      // are distinguishable before committing to either. Mirrors the panel's +/- wording.
      const extent = `+${hunk.newLines}/-${hunk.oldLines}`;

      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(check) Accept ${extent}`,
          command: 'interactiveReview.codeLensAcceptHunk',
          arguments: [document.uri.fsPath, id],
        }),
        new vscode.CodeLens(range, {
          title: '$(x) Discard',
          command: 'interactiveReview.codeLensDiscardHunk',
          arguments: [document.uri.fsPath, id],
        }),
      );
    }

    return lenses;
  }

  /**
   * File-level Accept/Restore actions for a deleted file, anchored to the top of
   * the empty modified side of its diff. That URI is
   * `vscode.Uri.file(filePath).with({ scheme: 'interactive-review-deleted' })`, so
   * `.fsPath` is the real file path. Only rendered when the file is genuinely
   * deleted (tracked, missing on disk) and its deleted diff is the active tab.
   */
  private provideDeletedFileLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const fsPath = document.uri.fsPath;
    const fileState = this.stateManager.getFile(fsPath);
    if (!fileState || fileState.status !== 'reviewing') return [];
    // Deleted = had a baseline but no longer on disk (see StateManager.isDeleted).
    // A null baseline is a *new* file and an existing file is an ordinary edit.
    if (!this.stateManager.isDeleted(fsPath)) return [];
    if (!this.isActiveDeletedReviewTab(fsPath)) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: '$(check) Accept deletion',
        command: 'interactiveReview.codeLensAcceptFile',
        arguments: [fsPath],
      }),
      new vscode.CodeLens(range, {
        title: '$(discard) Restore file',
        command: 'interactiveReview.codeLensRestoreFile',
        arguments: [fsPath],
      }),
    ];
  }

  private isActiveDeletedReviewTab(fsPath: string): boolean {
    for (const group of vscode.window.tabGroups.all) {
      const active = group.activeTab;
      if (active?.input instanceof vscode.TabInputTextDiff) {
        if (active.input.original.scheme === 'interactive-review-baseline'
          && active.input.original.fsPath === fsPath
          && active.input.modified.scheme === 'interactive-review-deleted') {
          return true;
        }
      }
    }
    return false;
  }

  private hasVisibleNormalEditor(uri: vscode.Uri): boolean {
    const fsPath = uri.fsPath;
    return vscode.window.visibleTextEditors.some(
      e => e.document.uri.scheme === 'file'
        && e.document.uri.fsPath === fsPath
        && e.viewColumn !== undefined
    );
  }

  private isActiveReviewDiffTab(uri: vscode.Uri): boolean {
    const fsPath = uri.fsPath;
    for (const group of vscode.window.tabGroups.all) {
      const active = group.activeTab;
      if (active?.input instanceof vscode.TabInputTextDiff) {
        // The scheme check matters: a deleted file's diff carries the SAME fsPath on its
        // modified side under `interactive-review-deleted`. Without it, a stale
        // file-scheme doc for that path would also claim the tab and render per-hunk
        // lenses alongside the deleted-file Accept/Restore pair.
        if (active.input.original.scheme === 'interactive-review-baseline'
          && active.input.modified.scheme === 'file'
          && active.input.modified.fsPath === fsPath) {
          return true;
        }
      }
    }
    return false;
  }
}
