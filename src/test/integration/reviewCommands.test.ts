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
// Keyboard-driven review commands resolve their target from the active editor and
// cursor position (keybindings carry no arguments). The target is the diff editor's
// modified side, a file-scheme editor for the reviewing file.

suite('interactive-review keyboard commands', function () {
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

  async function openReviewingFile(filePath: string, cursorLine0: number): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    const pos = new vscode.Position(cursorLine0, 0);
    editor.selection = new vscode.Selection(pos, pos);
    return editor;
  }

  test('acceptHunk command folds the hunk under the cursor into the baseline', async () => {
    const root = getWorkspaceRoot();
    const f = path.join(root, 'edit.txt');
    writeFileExternally(f, 'l1\nl2\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'edit.txt') !== undefined);

    writeFileExternally(f, 'l1\nl2\nl3\n'); // added line → reviewing
    await waitForReviewing(f);

    await openReviewingFile(f, 2); // cursor on the added line
    await vscode.commands.executeCommand('interactiveReview.acceptHunk');
    await sleep(300);

    assert.strictEqual(gitGetBaseline(root, 'edit.txt'), 'l1\nl2\nl3\n',
      'accepting folds current content into the baseline');
    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing', 'file resolved');
  });

  test('rejectHunk command reverts the hunk under the cursor to baseline', async () => {
    const root = getWorkspaceRoot();
    const f = path.join(root, 'revert.txt');
    writeFileExternally(f, 'l1\nl2\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'revert.txt') !== undefined);

    writeFileExternally(f, 'l1\nl2\nl3\n');
    await waitForReviewing(f);

    await openReviewingFile(f, 2);
    await vscode.commands.executeCommand('interactiveReview.rejectHunk');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nl2\n',
      'rejecting reverts the file to the baseline');
    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing', 'file resolved');
  });

  test('nextHunk past a file’s last hunk opens the next reviewing file', async () => {
    const root = getWorkspaceRoot();
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    writeFileExternally(a, 'a1\n');
    writeFileExternally(b, 'b1\n');
    await enableReview();
    await waitForCondition(() =>
      gitGetBaseline(root, 'a.txt') !== undefined && gitGetBaseline(root, 'b.txt') !== undefined);

    writeFileExternally(a, 'a1\na2\n');
    writeFileExternally(b, 'b1\nb2\n');
    await waitForReviewing(a);
    await waitForReviewing(b);

    await openReviewingFile(a, 1); // cursor on/after a's only hunk
    await vscode.commands.executeCommand('interactiveReview.nextHunk');
    await sleep(300);

    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, b,
      'no further hunk in a → advance opens the next reviewing file b');
  });

  test('commands are inert when the active editor is not a reviewing file', async () => {
    const root = getWorkspaceRoot();
    const plain = path.join(root, 'plain.txt');
    writeFileExternally(plain, 'untouched\n');
    await enableReview(); // plain becomes a baseline, not reviewing (no diff)
    await waitForCondition(() => gitGetBaseline(root, 'plain.txt') !== undefined);

    await openReviewingFile(plain, 0);
    const before = fs.readFileSync(plain, 'utf-8');
    // No reviewing target → command resolves nothing and must not mutate.
    await vscode.commands.executeCommand('interactiveReview.acceptHunk');
    await vscode.commands.executeCommand('interactiveReview.rejectHunk');
    await sleep(200);

    assert.strictEqual(fs.readFileSync(plain, 'utf-8'), before, 'no mutation on a non-reviewing file');
    assert.strictEqual(getStateManager().getFile(plain)?.status, undefined, 'plain never entered reviewing');
  });
});
