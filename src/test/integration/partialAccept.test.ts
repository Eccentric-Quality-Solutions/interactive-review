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
// Partial accept (interactiveReview.acceptSelection) folds only the added lines inside the
// editor selection that fall inside a pending hunk into the baseline, leaving the rest
// pending. Unlike reject it never edits the buffer — the accepted content is already on
// disk; only the baseline advances so those lines stop being flagged as changes.

suite('interactive-review partial accept', function () {
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

  test('partial accept of a mixed hunk folds only the selected added lines into baseline; rest stays pending', async () => {
    // Insert A,B,C between l1 and l2 → one hunk, added doc lines 1,2,3.
    const f = await reviewing('mixed.txt', 'l1\nl2\n', 'l1\nA\nB\nC\nl2\n');

    await openWithSelection(f, 1, 2); // select A and B
    await vscode.commands.executeCommand('interactiveReview.acceptSelection');
    await sleep(300);

    // Accept never touches the buffer — the file on disk is unchanged.
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nA\nB\nC\nl2\n',
      'accept does not edit the buffer; the added content stays on disk');
    const st = getStateManager().getFile(f);
    assert.strictEqual(st?.status, 'reviewing', 'the remaining added line C keeps the file in reviewing');
    assert.strictEqual(st?.baseline, 'l1\nA\nB\nl2\n',
      'A and B are folded into the baseline; only C is left as a pending addition');
  });

  test('selection spanning a hunk boundary only accepts the intersecting added lines', async () => {
    const f = await reviewing('boundary.txt', 'l1\nl2\n', 'l1\nA\nB\nC\nl2\n');

    await openWithSelection(f, 0, 1); // context line l1 (0) through added line A (1)
    await vscode.commands.executeCommand('interactiveReview.acceptSelection');
    await sleep(300);

    const st = getStateManager().getFile(f);
    assert.strictEqual(st?.baseline, 'l1\nA\nl2\n',
      'context line l1 is ignored; only the added line A in range is folded into the baseline');
    assert.strictEqual(st?.status, 'reviewing', 'B and C stay pending');
  });

  test('pure-removal hunk falls back to whole-hunk accept', async () => {
    // Remove l2 → a pure-removal hunk (no added lines) at the l3 position.
    const f = await reviewing('removal.txt', 'l1\nl2\nl3\n', 'l1\nl3\n');

    await openWithSelection(f, 1, 1); // cursor on l3, where the removal hunk sits
    await vscode.commands.executeCommand('interactiveReview.acceptSelection');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nl3\n',
      'accept keeps the buffer; the removal is folded into the baseline');
    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing',
      'baseline now matches the buffer → file exits reviewing');
  });

  test('selection covering only context is a no-op', async () => {
    const f = await reviewing('contextonly.txt', 'l1\nl2\n', 'l1\nA\nl2\n');

    await openWithSelection(f, 0, 0); // context line l1 only
    await vscode.commands.executeCommand('interactiveReview.acceptSelection');
    await sleep(300);

    const st = getStateManager().getFile(f);
    assert.strictEqual(st?.status, 'reviewing', 'nothing accepted → file stays in reviewing');
    assert.strictEqual(st?.baseline, 'l1\nl2\n', 'baseline is unchanged when no added line is selected');
  });

  test('multi-hunk selection accepts the hunk at the selection start only', async () => {
    // Two separate insertions: A after l1, B after l3.
    const f = await reviewing('multi.txt', 'l1\nl2\nl3\n', 'l1\nA\nl2\nl3\nB\n');

    await openWithSelection(f, 1, 4); // spans A (hunk 1) through B (hunk 2)
    await vscode.commands.executeCommand('interactiveReview.acceptSelection');
    await sleep(300);

    const st = getStateManager().getFile(f);
    assert.strictEqual(st?.baseline, 'l1\nA\nl2\nl3\n',
      'only the start hunk (A) is folded into the baseline; B is left pending');
    assert.strictEqual(st?.status, 'reviewing', 'the ignored second hunk (B) keeps the file in reviewing');
  });

  test('partial accept resolving the file’s last change completes the file', async () => {
    const f = await reviewing('last.txt', 'l1\nl2\n', 'l1\nA\nl2\n');

    await openWithSelection(f, 1, 1); // the only added line
    await vscode.commands.executeCommand('interactiveReview.acceptSelection');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nA\nl2\n', 'buffer keeps the accepted content');
    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing',
      'no pending changes left → file exits reviewing');
  });
});
