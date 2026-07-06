import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks } from './diffEngine';

/**
 * In-file review surface built on stable APIs. When the decorations surface is
 * active (`useDiffEditor === false && showInlineDecorations === true`), pending
 * added lines of every visible reviewing file are highlighted in place with a
 * single `TextEditorDecorationType` — an alternative to opening the native diff
 * editor. Removed lines can't be rendered inline on stable APIs; they stay
 * reachable via the `DiffCodeLensProvider`'s "Show N removed lines" peek.
 *
 * `refresh()` is the only entry point: it is driven off the existing
 * `onStateChanged` funnel plus document/editor change events, so decorations
 * stay in sync with the pending set after every mutation, edit, or surface
 * switch. When the surface is inactive (diff mode, decorations disabled, review
 * off, or the file is no longer reviewing) it clears the decoration so switching
 * surfaces is honored immediately.
 */
export class InlineDecorations {
  private readonly addedType: vscode.TextEditorDecorationType;
  // Test-visibility: the added-line ranges last applied to each file's editor.
  // Decorations are write-only in the VS Code API, so this map is how tests (and
  // any future consumer) observe what the surface decorated.
  private readonly lastRanges = new Map<string, vscode.Range[]>();

  constructor(private stateManager: StateManager) {
    this.addedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  /** The decorations surface is the active review surface. */
  private get active(): boolean {
    return this.stateManager.enabled
      && !this.stateManager.useDiffEditor
      && this.stateManager.showInlineDecorations;
  }

  /** Re-decorate every visible editor. Cheap; safe to call on any state change. */
  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorateEditor(editor);
    }
  }

  private decorateEditor(editor: vscode.TextEditor): void {
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') return;

    const fileState = this.active ? this.stateManager.getFile(uri.fsPath) : undefined;
    if (!fileState || fileState.status !== 'reviewing') {
      editor.setDecorations(this.addedType, []);
      this.lastRanges.set(uri.fsPath, []);
      return;
    }

    const hunks = computeHunks(fileState.baseline, editor.document.getText());
    const ranges: vscode.Range[] = [];
    for (const hunk of hunks) {
      if (hunk.newLines === 0) continue; // pure removal — no added lines to highlight
      const start = Math.max(0, hunk.newStart - 1);
      const end = start + hunk.newLines - 1;
      ranges.push(new vscode.Range(start, 0, end, 0));
    }
    editor.setDecorations(this.addedType, ranges);
    this.lastRanges.set(uri.fsPath, ranges);
  }

  /** Test-visibility: the added-line ranges last applied to this file's editor. */
  rangesFor(fsPath: string): vscode.Range[] {
    return this.lastRanges.get(fsPath) ?? [];
  }

  dispose(): void {
    this.addedType.dispose();
  }
}
