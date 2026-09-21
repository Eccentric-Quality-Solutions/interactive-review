import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitListTracked, gitGetBaseline,
  sleep, waitForCondition, waitForReviewing, enableReview, disableReview,
  writeFileExternally, renameFileViaVSCode, deleteFileViaVSCode, cleanWorkspace,
  getStateManager,
} from './helpers';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('interactive-review rename integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('rename a new file preserves tracking under new path', async () => {
    const root = getWorkspaceRoot();
    await enableReview();

    // Externally create a new file → triggers review with null baseline
    const oldPath = path.join(root, 'new-file.txt');
    writeFileExternally(oldPath, 'new file content\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    // Rescan-nudged: this is the *precondition*, not the subject. The subject is what a
    // rename does to an already-reviewing file, and a plain wait here makes the test fail
    // whenever the host's create event is merely late — which under full-suite load it
    // regularly is. `waitForReviewing` reaches the same state deterministically.
    await waitForReviewing(oldPath);

    // Rename via VSCode API
    const newPath = path.join(root, 'new-file-renamed.txt');
    await renameFileViaVSCode(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));

    await waitForCondition(() => {
      const f = sm.getFile(newPath);
      return f?.status === 'reviewing';
    }, 5000);

    // Verify: new path is tracked in memory, old path is not
    assert.ok(!sm.getFile(oldPath), `Old path should not be in state`);
    assert.ok(sm.getFile(newPath), `New path should be in state`);

    // Verify: baseline is null (new file) — null-baseline files are not in git
    assert.strictEqual(sm.getFile(newPath)?.baseline, null, 'Baseline should be null for new file');

    // Verify: file exists on disk at new path
    assert.ok(fs.existsSync(newPath), 'File should exist at new path');
    assert.ok(!fs.existsSync(oldPath), 'File should not exist at old path');
  });

  test('rename a reviewing file preserves baseline under new path', async () => {
    const root = getWorkspaceRoot();

    // Create a file BEFORE enable so it gets snapshotted as baseline
    const filePath = path.join(root, 'reviewing-file.txt');
    writeFileExternally(filePath, 'original content\n');

    await enableReview();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 8000);
    const baselineBefore = gitGetBaseline(root, rel)!;

    // Externally modify the file → triggers review mode
    writeFileExternally(filePath, 'original content\nmodified line\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    // Rename via VSCode API while in reviewing state
    const newPath = path.join(root, 'reviewing-file-renamed.txt');
    const newRel = path.relative(root, newPath);
    await renameFileViaVSCode(vscode.Uri.file(filePath), vscode.Uri.file(newPath));

    await waitForCondition(() => gitListTracked(root).includes(newRel), 5000);

    // Verify: new path is tracked, old path is not
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(rel), `Old path "${rel}" should not be tracked`);
    assert.ok(tracked.includes(newRel), `New path "${newRel}" should be tracked`);

    // Verify: baseline content is preserved (the original, not the modified)
    const baselineAfter = gitGetBaseline(root, newRel);
    assert.strictEqual(baselineAfter, baselineBefore, 'Baseline should be preserved after rename');

    // Verify: file on disk has the modified content
    const diskContent = fs.readFileSync(newPath, 'utf-8');
    assert.strictEqual(diskContent, 'original content\nmodified line\n');
  });

  test('deleting a folder via VS Code drops every baseline under it, and refresh does not resurrect them', async () => {
    // Regression guard for the watcher *wiring*, which is where this bug lived: the
    // user-delete branch called removeFile(<dir>), which git turns into a successful no-op.
    // The unit tests pin the mechanism (removePathAndChildren, and git's behaviour); only a
    // real editor delete exercises the path from onWillDeleteFiles through onDiskDelete.
    //
    // `nested/b.txt` is never edited, so it has a baseline in git and no entry in memory.
    // Those are exactly the files the old code stranded.
    const root = getWorkspaceRoot();
    const dir = path.join(root, 'doomed');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    writeFileExternally(path.join(dir, 'a.txt'), 'a\n');
    writeFileExternally(path.join(dir, 'nested', 'b.txt'), 'b\n');
    writeFileExternally(path.join(root, 'survivor.txt'), 's\n');

    await enableReview();
    await waitForCondition(() => {
      const t = gitListTracked(root);
      return t.includes('doomed/a.txt') && t.includes('doomed/nested/b.txt') && t.includes('survivor.txt');
    }, 8000);

    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(vscode.Uri.file(dir), { recursive: true });
    assert.ok(await vscode.workspace.applyEdit(edit), 'the folder delete itself should succeed');

    await waitForCondition(() => !gitListTracked(root).some(f => f.startsWith('doomed/')), 8000);

    // The user-visible symptom was phantom *deletions* reappearing after a Refresh or window
    // reload, since a tracked file missing from disk reads as a pending deletion.
    await vscode.commands.executeCommand('interactiveReview.refresh');
    const sm = getStateManager()!;
    assert.strictEqual(sm.getFile(path.join(dir, 'a.txt')), undefined, 'a.txt must not return as a pending deletion');
    assert.strictEqual(sm.getFile(path.join(dir, 'nested', 'b.txt')), undefined, 'nested/b.txt must not return as a pending deletion');
    assert.ok(gitListTracked(root).includes('survivor.txt'), 'the sibling outside the folder keeps its baseline');
  });

  test('manual delete via VSCode does not produce a deletion hunk', async () => {
    const root = getWorkspaceRoot();

    // Create a file BEFORE enable so it gets snapshotted as baseline
    const filePath = path.join(root, 'to-delete.txt');
    writeFileExternally(filePath, 'delete me\n');

    await enableReview();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 8000);

    // Delete via VSCode API (user-initiated)
    await deleteFileViaVSCode(vscode.Uri.file(filePath));

    await waitForCondition(() => !gitListTracked(root).includes(rel), 5000);

    // Verify: file is no longer tracked in interactive-review git
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(rel), `Deleted file "${rel}" should not be tracked`);

    // Verify: file does not exist on disk
    assert.ok(!fs.existsSync(filePath), 'File should not exist on disk');
  });
});
