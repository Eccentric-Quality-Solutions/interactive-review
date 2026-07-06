import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import { computeHunks, hunkId } from '../../diffEngine';
import {
  getWorkspaceRoot, gitGetBaseline, sleep, waitForCondition,
  waitForReviewing, enableReview, disableReview,
  writeFileExternally, cleanWorkspace, getStateManager, getInlineDecorations,
} from './helpers';

// ── Test suite ────────────────────────────────────────────────────────────────
//
// The inline-decorations surface highlights pending added lines directly in the
// normal editor when `useDiffEditor === false && showInlineDecorations === true`.
// Decorations are write-only in the VS Code API, so we assert against the ranges
// InlineDecorations records (getInlineDecorations().rangesFor(path)) rather than
// reading VS Code's applied decorations, which aren't observable.

suite('interactive-review inline decorations', function () {
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

  /** Open the file in the normal editor and force a decoration refresh. */
  async function openAndDecorate(filePath: string): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    getInlineDecorations().refresh();
    await sleep(50);
  }

  test('added lines are highlighted in place in the normal editor', async () => {
    // Insert A,B,C between l1 and l2 → added doc lines 1,2,3 (0-based).
    const f = await reviewing('added.txt', 'l1\nl2\n', 'l1\nA\nB\nC\nl2\n');
    getStateManager().setUseDiffEditor(false);
    getStateManager().setShowInlineDecorations(true);

    await openAndDecorate(f);

    const ranges: vscode.Range[] = getInlineDecorations().rangesFor(f);
    assert.strictEqual(ranges.length, 1, 'one contiguous added-line block is decorated');
    assert.strictEqual(ranges[0].start.line, 1, 'decoration starts at the first added line');
    assert.strictEqual(ranges[0].end.line, 3, 'decoration ends at the last added line');
  });

  test('surface selection honors settings: diff-editor mode decorates nothing', async () => {
    const f = await reviewing('surface.txt', 'l1\nl2\n', 'l1\nA\nl2\n');
    getStateManager().setUseDiffEditor(true); // diff surface, not decorations
    getStateManager().setShowInlineDecorations(true);

    await openAndDecorate(f);

    assert.strictEqual(getInlineDecorations().rangesFor(f).length, 0,
      'no decorations when the diff editor is the selected surface');
  });

  test('surface selection honors settings: decorations disabled decorates nothing', async () => {
    const f = await reviewing('disabled.txt', 'l1\nl2\n', 'l1\nA\nl2\n');
    getStateManager().setUseDiffEditor(false);
    getStateManager().setShowInlineDecorations(false); // plain normal editor, no highlights

    await openAndDecorate(f);

    assert.strictEqual(getInlineDecorations().rangesFor(f).length, 0,
      'no decorations when showInlineDecorations is off');
  });

  test('accepting a hunk clears its decoration', async () => {
    const f = await reviewing('accept.txt', 'l1\nl2\n', 'l1\nA\nl2\n');
    getStateManager().setUseDiffEditor(false);
    getStateManager().setShowInlineDecorations(true);

    const editor = await vscode.window.showTextDocument(vscode.Uri.file(f));
    const hunk = computeHunks(getStateManager().getFile(f).baseline, editor.document.getText())[0];
    getInlineDecorations().refresh();
    await sleep(50);
    assert.strictEqual(getInlineDecorations().rangesFor(f).length, 1, 'decorated before accept');

    await vscode.commands.executeCommand('interactiveReview.codeLensAcceptHunk', f, hunkId(hunk));
    await sleep(300);

    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing',
      'the only hunk was accepted → file exits reviewing');
    assert.strictEqual(getInlineDecorations().rangesFor(f).length, 0,
      'the decoration clears once the added line is folded into the baseline');
  });
});
