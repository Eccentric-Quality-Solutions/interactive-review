import * as vscode from 'vscode';

// Shared editor/document lookups used by both commands.ts and reviewPanel.ts.
//
// The `scheme === 'file'` filter in the finders below is LOAD-BEARING, not
// cosmetic: when a review diff is open, its baseline side is a document with the
// SAME fsPath but scheme `interactive-review-baseline`. An unfiltered lookup by
// fsPath can grab that read-only baseline doc/editor, making `computeHunks` see
// zero changes and silently drop the file (or reveal a hunk in the wrong pane).
// Centralizing the lookup here keeps that reasoning in one place so no call site
// can forget the filter.

/** The editable on-disk document for `filePath`, or undefined if not open. */
export function findFileDocument(filePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    d => d.uri.scheme === 'file' && d.uri.fsPath === filePath
  );
}

/**
 * A visible editor for the editable on-disk file at `filePath`. When a review
 * diff is open its embedded modified pane (`viewColumn === undefined`) is
 * preferred; otherwise a normal editor for the file is returned. Undefined if
 * none is visible.
 */
export function findFileEditor(filePath: string): vscode.TextEditor | undefined {
  const candidates = vscode.window.visibleTextEditors.filter(
    e => e.document.uri.scheme === 'file' && e.document.uri.fsPath === filePath
  );
  return candidates.find(e => e.viewColumn === undefined) ?? candidates[0];
}

/**
 * Move the cursor to the start line of a hunk (`newStart`, 1-based) and center it
 * in view. `newStart` is clamped so a hunk at the top of the file is valid.
 */
export function revealHunkPosition(editor: vscode.TextEditor, newStart: number): void {
  const pos = new vscode.Position(Math.max(0, newStart - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}
