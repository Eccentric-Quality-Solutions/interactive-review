import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks, hunkId } from './diffEngine';

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
      // CodeLens renders above the target line, so place it on the line
      // after the hunk to appear visually below the changed block.
      const afterHunk = hunk.newStart - 1 + hunk.newLines;
      const line = Math.min(afterHunk, document.lineCount - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const id = hunkId(hunk);

      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(check) Accept',
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
        if (active.input.original.scheme === 'interactive-review-baseline'
          && active.input.modified.fsPath === fsPath) {
          return true;
        }
      }
    }
    return false;
  }
}
