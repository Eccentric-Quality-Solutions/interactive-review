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
    if (document.uri.scheme !== 'file') return [];
    if (!this.stateManager.enabled) return [];

    const fileState = this.stateManager.getFile(document.uri.fsPath);
    if (!fileState || fileState.status !== 'reviewing') return [];

    // Two surfaces, two gating rules:
    // - Decorations surface (useDiffEditor false + showInlineDecorations true):
    //   the file is shown in a normal editor with no diff tab, so render the
    //   per-hunk actions directly on that editor. Also offer a peek of the
    //   removed lines, which decorations cannot render inline on stable APIs.
    // - Diff surface: render on the active review diff tab, and suppress when a
    //   normal editor is also visible (split view) to avoid duplicate actions.
    const decorationsMode =
      !this.stateManager.useDiffEditor && this.stateManager.showInlineDecorations;
    if (decorationsMode) {
      if (!this.hasVisibleNormalEditor(document.uri)) return [];
    } else {
      if (!this.isActiveReviewDiffTab(document.uri)) return [];
      if (this.hasVisibleNormalEditor(document.uri)) return [];
    }

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

      // In decorations mode the removed baseline lines aren't visible; offer a
      // peek at them. (In the diff surface they're already shown side-by-side.)
      if (decorationsMode && hunk.removedContent.length > 0) {
        const n = hunk.removedContent.length;
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(diff-removed) Show ${n} removed line${n === 1 ? '' : 's'}`,
            command: 'interactiveReview.showRemovedLines',
            arguments: [document.uri.fsPath, id],
          }),
        );
      }
    }

    return lenses;
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
