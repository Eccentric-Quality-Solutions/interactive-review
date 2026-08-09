import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline, sleep, waitForCondition,
  waitForReviewing, enableReview, disableReview,
  writeFileExternally, cleanWorkspace, getStateManager,
} from './helpers';

// ── Test suite ────────────────────────────────────────────────────────────────
//
// Partial reject (interactiveReview.rejectSelection) deletes only the added lines inside
// the editor selection that fall inside a pending hunk, leaving the rest pending. It
// resolves the hunk at the selection start and recomputes against the unchanged baseline.

suite('interactive-review partial reject', function () {
  this.timeout(30000);

  setup(async function () {
    cleanWorkspace();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    cleanWorkspace();
  });

  /** Open the file and set a (possibly multi-line) 0-based selection. */
  async function openWithSelection(filePath: string, startLine0: number, endLine0: number): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    const doc = editor.document;
    const endCol = doc.lineAt(Math.min(endLine0, doc.lineCount - 1)).text.length;
    editor.selection = new vscode.Selection(
      new vscode.Position(startLine0, 0),
      new vscode.Position(endLine0, endCol),
    );
    return editor;
  }

  /** Enable review on a file, then modify it so it enters reviewing. */
  async function reviewing(name: string, baseline: string, modified: string): Promise<string> {
    const root = getWorkspaceRoot();
    const f = path.join(root, name);
    writeFileExternally(f, baseline);
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, name) !== undefined);
    writeFileExternally(f, modified);
    await waitForReviewing(f);
    return f;
  }

  test('partial reject of a mixed hunk deletes only the selected added lines; rest stays pending', async () => {
    // Insert A,B,C between l1 and l2 → one hunk, added doc lines 1,2,3.
    const f = await reviewing('mixed.txt', 'l1\nl2\n', 'l1\nA\nB\nC\nl2\n');

    await openWithSelection(f, 1, 2); // select A and B
    await vscode.commands.executeCommand('interactiveReview.rejectSelection');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nC\nl2\n',
      'only the selected added lines A and B are deleted; C stays');
    assert.strictEqual(getStateManager().getFile(f)?.status, 'reviewing',
      'the remaining added line C keeps the file in reviewing');
  });

  test('selection spanning a hunk boundary only reverts the intersecting added lines', async () => {
    const f = await reviewing('boundary.txt', 'l1\nl2\n', 'l1\nA\nB\nC\nl2\n');

    await openWithSelection(f, 0, 1); // context line l1 (0) through added line A (1)
    await vscode.commands.executeCommand('interactiveReview.rejectSelection');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nB\nC\nl2\n',
      'context line l1 is ignored; only the added line A in range is deleted');
    assert.strictEqual(getStateManager().getFile(f)?.status, 'reviewing');
  });

  test('pure-removal hunk falls back to whole-hunk reject', async () => {
    // Remove l2 → a pure-removal hunk (no added lines) at the l3 position.
    const f = await reviewing('removal.txt', 'l1\nl2\nl3\n', 'l1\nl3\n');

    await openWithSelection(f, 1, 1); // cursor on l3, where the removal hunk sits
    await vscode.commands.executeCommand('interactiveReview.rejectSelection');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nl2\nl3\n',
      'fallback restores the removed baseline line l2');
    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing',
      'file matches baseline again → exits reviewing');
  });

  test('multi-hunk selection resolves the hunk at the selection start only', async () => {
    // Two separate insertions: A after l1, B after l3.
    const f = await reviewing('multi.txt', 'l1\nl2\nl3\n', 'l1\nA\nl2\nl3\nB\n');

    await openWithSelection(f, 1, 4); // spans A (hunk 1) through B (hunk 2)
    await vscode.commands.executeCommand('interactiveReview.rejectSelection');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nl2\nl3\nB\n',
      'only the start hunk (A) is resolved; the second hunk (B) is left pending');
    assert.strictEqual(getStateManager().getFile(f)?.status, 'reviewing',
      'the ignored second hunk keeps the file in reviewing');
  });

  test('partial reject resolving the file’s last change completes the file', async () => {
    const f = await reviewing('last.txt', 'l1\nl2\n', 'l1\nA\nl2\n');

    await openWithSelection(f, 1, 1); // the only added line
    await vscode.commands.executeCommand('interactiveReview.rejectSelection');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nl2\n', 'file reverts to baseline');
    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing',
      'no pending changes left → file exits reviewing');
  });

  test('a partial reject is a single undo', async () => {
    const f = await reviewing('undo.txt', 'l1\nl2\n', 'l1\nA\nB\nC\nl2\n');

    const editor = await openWithSelection(f, 1, 2); // A and B
    await vscode.commands.executeCommand('interactiveReview.rejectSelection');
    // Poll rather than sleep: under full-suite load the workspace edit and the undo
    // can both land later than a fixed delay allows. Polling for the exact expected
    // text keeps the assertion strict — a two-step undo stack would settle on
    // 'l1\nB\nC\nl2\n' and time out here rather than pass.
    // On timeout fall through to the assert so the failure shows the actual text.
    await waitForCondition(() => editor.document.getText() === 'l1\nC\nl2\n').catch(() => {});
    assert.strictEqual(editor.document.getText(), 'l1\nC\nl2\n', 'lines deleted');

    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand('undo');
    await waitForCondition(() => editor.document.getText() === 'l1\nA\nB\nC\nl2\n').catch(() => {});
    assert.strictEqual(editor.document.getText(), 'l1\nA\nB\nC\nl2\n',
      'a single undo restores both deleted lines at once');
  });
});
