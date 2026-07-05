import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline,
  sleep, waitForCondition, enableReview, disableReview,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
} from './helpers';
import { acceptHunk, discardHunk } from '../../commands';
import { computeHunks, hunkId } from '../../diffEngine';

suite('interactive-review diff editor integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    // Close all editors to clean up diff tabs
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  /**
   * Helper: create a file, enable interactive-review, then modify externally to produce hunks.
   */
  async function setupReviewingFile(filename: string, baseline: string, modified: string): Promise<string> {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, filename);

    writeFileExternally(filePath, baseline);
    await enableReview();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) === baseline, 5000);

    writeFileExternally(filePath, modified);

    const sm = getStateManager();
    await waitForCondition(() => sm.getFile(filePath)?.status === 'reviewing', 5000);

    return filePath;
  }

  // ── useDiffEditor setting ──────────────────────────────────────────────────

  test('useDiffEditor setting persists and defaults to false', async () => {
    await enableReview();
    const sm = getStateManager();
    assert.strictEqual(sm.useDiffEditor, false, 'useDiffEditor should default to false');

    sm.setUseDiffEditor(true);
    assert.strictEqual(sm.useDiffEditor, true);

    sm.setUseDiffEditor(false);
    assert.strictEqual(sm.useDiffEditor, false);
  });

  test('showInlineDecorations setting persists and defaults to true', async () => {
    await enableReview();
    const sm = getStateManager();
    assert.strictEqual(sm.showInlineDecorations, true, 'showInlineDecorations should default to true');

    sm.setShowInlineDecorations(false);
    assert.strictEqual(sm.showInlineDecorations, false);

    sm.setShowInlineDecorations(true);
    assert.strictEqual(sm.showInlineDecorations, true);
  });

  // ── textDocuments scheme filtering ────────────────────────────────────────

  test('acceptHunk finds doc by file scheme even when baseline doc exists', async () => {
    const filePath = await setupReviewingFile(
      'scheme-test.txt',
      'line 1\nline 2\nline 3\n',
      'line 1\nMODIFIED\nline 3\n'
    );

    const sm = getStateManager();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState);

    // Open a interactive-review diff to ensure interactive-review-baseline document exists in textDocuments
    const baselineUri = vscode.Uri.file(filePath).with({ scheme: 'interactive-review-baseline' });
    const currentUri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('vscode.diff', baselineUri, currentUri, 'test diff');
    await sleep(500);

    // Now accept the hunk — should work despite baseline doc being open
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length > 0, 'Should have at least one hunk');

    acceptHunk(sm, filePath, hunkId(hunks[0]), () => {});
    await sleep(200);

    // Should have processed (not skipped due to scheme mismatch)
    const updated = sm.getFile(filePath);
    // Either file exited reviewing (last hunk) or baseline was updated
    if (updated) {
      const remaining = computeHunks(updated.baseline, doc.getText());
      assert.ok(remaining.length < hunks.length, 'Hunk count should decrease after accept');
    }
  });

  // ── closeStaleTabs ────────────────────────────────────────────

  test('accepting last hunk closes interactive-review diff tab', async () => {
    const filePath = await setupReviewingFile(
      'auto-close.txt',
      'original\n',
      'modified\n'
    );

    const sm = getStateManager();
    const fileState = sm.getFile(filePath)!;

    // Open interactive-review diff tab
    const baselineUri = vscode.Uri.file(filePath).with({ scheme: 'interactive-review-baseline' });
    const currentUri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('vscode.diff', baselineUri, currentUri, 'test diff');
    await sleep(500);

    // Verify diff tab exists
    const hasDiffTab = () => {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputTextDiff
            && tab.input.original.scheme === 'interactive-review-baseline'
            && tab.input.modified.fsPath === filePath) {
            return true;
          }
        }
      }
      return false;
    };
    assert.ok(hasDiffTab(), 'Diff tab should exist before accept');

    const hunks = computeHunks(fileState.baseline, 'modified\n');
    assert.strictEqual(hunks.length, 1);

    // Accept via the extension's wired callback (simulating CodeLens/inset)
    const ext = vscode.extensions.getExtension('eccentricqualitysolutions.vsc-interactive-review');
    assert.ok(ext?.isActive);

    // Use the CodeLens command which wires closeStaleTabs
    await vscode.commands.executeCommand('interactiveReview.codeLensAcceptHunk', filePath, hunkId(hunks[0]));
    await sleep(1000);

    // File should exit reviewing
    const updated = sm.getFile(filePath);
    assert.ok(!updated || updated.status !== 'reviewing', 'Should exit reviewing');

    // Diff tab should be closed
    assert.ok(!hasDiffTab(), 'Diff tab should be closed after last hunk accepted');
  });

  // ── CodeLens visibility ────────────────────────────────────────────────────

  /** Per-hunk CodeLens contributed by the provider for a file. */
  async function reviewLensesFor(filePath: string): Promise<vscode.CodeLens[]> {
    const codeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', vscode.Uri.file(filePath)
    );
    return (codeLenses ?? []).filter(
      l => l.command?.command === 'interactiveReview.codeLensAcceptHunk'
        || l.command?.command === 'interactiveReview.codeLensDiscardHunk'
    );
  }

  test('diff surface: no CodeLens in a stray normal editor (only the diff tab carries them)', async () => {
    const filePath = await setupReviewingFile(
      'codelens-test.txt',
      'line 1\n',
      'changed line 1\n'
    );
    // Diff surface, so the decorations surface is inactive.
    getStateManager().setUseDiffEditor(true);

    // Open a stray normal editor (no diff tab) — no CodeLens expected on the diff surface.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
    await sleep(300);

    assert.strictEqual((await reviewLensesFor(filePath)).length, 0,
      'no interactive-review CodeLens in a stray normal editor on the diff surface');
  });

  test('decorations surface: per-hunk CodeLens appear on the normal editor (parity)', async () => {
    const filePath = await setupReviewingFile(
      'codelens-decorations.txt',
      'line 1\n',
      'changed line 1\n'
    );
    // Decorations surface: the normal editor is the review surface.
    getStateManager().setUseDiffEditor(false);
    getStateManager().setShowInlineDecorations(true);

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
    await sleep(300);

    assert.strictEqual((await reviewLensesFor(filePath)).length, 2,
      'accept + discard CodeLens render on the normal editor in decorations mode');
  });
});
