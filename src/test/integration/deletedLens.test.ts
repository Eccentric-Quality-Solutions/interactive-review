import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline, sleep, waitForCondition, waitForConditionNudged,
  enableReview, disableReview, writeFileExternally, cleanWorkspace, getStateManager,
} from './helpers';

/**
 * Verifies the deleted-file review surface end-to-end:
 *  - the deleted diff opens against the `interactive-review-deleted` modified side
 *    (no "file not found" on the missing real file), and
 *  - the file-level Accept/Restore CodeLenses render on that side and their commands
 *    actually accept the deletion / restore the file.
 */
suite('interactive-review deleted-file code lenses', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  /** Create a tracked file, enable review, then delete it so it enters reviewing as "deleted". */
  async function setupDeletedFile(filename: string, baseline: string): Promise<string> {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, filename);
    writeFileExternally(filePath, baseline);
    await enableReview();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) === baseline, 5000);

    fs.unlinkSync(filePath);
    const sm = getStateManager();
    // On timeout, report what actually happened — a lost git baseline and a lost state
    // entry are very different failures, and the bare "condition not met" hid that.
    try {
      await waitForConditionNudged(() => sm.getFile(filePath)?.status === 'reviewing', 5000);
    } catch {
      throw new Error(`${filename} never entered reviewing: state=${JSON.stringify(sm.getFile(filePath))} `
        + `baselineInGit=${JSON.stringify(gitGetBaseline(root, rel))} onDisk=${fs.existsSync(filePath)}`);
    }
    assert.strictEqual(fs.existsSync(filePath), false, 'file should be gone from disk');
    return filePath;
  }

  /** Open the deleted diff exactly as ReviewPanel.openDeletedDiffEditor does. */
  async function openDeletedDiff(filePath: string): Promise<vscode.Uri> {
    const fileName = path.basename(filePath);
    const baselineUri = vscode.Uri.file(filePath).with({ scheme: 'interactive-review-baseline' });
    const deletedUri = vscode.Uri.file(filePath).with({ scheme: 'interactive-review-deleted' });
    await vscode.commands.executeCommand('vscode.diff', baselineUri, deletedUri, `${fileName} (deleted)`);
    await sleep(500); // let the tab become active so isActiveDeletedReviewTab passes
    return deletedUri;
  }

  test('deleted modified side is an empty content-provider doc (no missing-file error)', async () => {
    const filePath = await setupDeletedFile('lens-empty.txt', 'one\ntwo\nthree\n');
    const deletedUri = await openDeletedDiff(filePath);

    // Opening the empty side must succeed and yield empty content — the old untitled
    // approach and, worse, pointing at the missing real file would error here.
    const doc = await vscode.workspace.openTextDocument(deletedUri);
    assert.strictEqual(doc.getText(), '', 'deleted modified side should be empty');
  });

  test('Accept/Restore lenses render on the deleted diff', async () => {
    const filePath = await setupDeletedFile('lens-render.txt', 'alpha\nbeta\n');
    const deletedUri = await openDeletedDiff(filePath);

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', deletedUri
    );
    const commands = (lenses ?? []).map(l => l.command?.command).sort();
    assert.deepStrictEqual(
      commands,
      ['interactiveReview.codeLensAcceptFile', 'interactiveReview.codeLensRestoreFile'],
      `expected both file-level lenses, got: ${JSON.stringify(commands)}`
    );
  });

  test('Restore lens command writes the file back from baseline', async () => {
    const baseline = 'restore-me line 1\nrestore-me line 2\n';
    const filePath = await setupDeletedFile('lens-restore.txt', baseline);
    await openDeletedDiff(filePath);

    await vscode.commands.executeCommand('interactiveReview.codeLensRestoreFile', filePath);

    const sm = getStateManager();
    await waitForConditionNudged(() => {
      const f = sm.getFile(filePath);
      return !f || f.status !== 'reviewing';
    }, 5000);
    assert.ok(fs.existsSync(filePath), 'file should be restored to disk');
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), baseline, 'restored content should equal baseline');
  });

  test('Accept lens command confirms the deletion (drops from tracking)', async () => {
    const filePath = await setupDeletedFile('lens-accept.txt', 'goodbye\n');
    await openDeletedDiff(filePath);

    await vscode.commands.executeCommand('interactiveReview.codeLensAcceptFile', filePath);

    const sm = getStateManager();
    await waitForConditionNudged(() => sm.getFile(filePath) === undefined, 5000);
    assert.strictEqual(fs.existsSync(filePath), false, 'file should stay deleted');
    assert.strictEqual(sm.getFile(filePath), undefined, 'file should no longer be tracked');
  });
});
