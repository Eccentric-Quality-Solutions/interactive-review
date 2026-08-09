import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline, gitListTracked, sleep, waitForReviewing,
  disableReview, writeFileExternally, cleanWorkspace, getStateManager, getReviewPanel,
} from './helpers';

/**
 * Covers the `review-trigger-ux` capability: the snapshot-on-command trigger surfaced as
 * explicit Begin/End review commands, and — the part with actual mechanics behind it — the
 * guarantee that begin-review is safe for an *agent* to invoke at a turn boundary.
 *
 * The agent tests deliberately bypass the `enableReview()` helper (which waits for the git
 * dir and then sleeps). An agent gets no such courtesy: it awaits `executeCommand` and
 * immediately starts editing. So these assert directly on the resolved promise with no
 * intervening wait — if the command ever resolves before the baseline is on disk, or ever
 * grows a dialog that blocks without a user, these fail.
 */
suite('interactive-review trigger UX', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('command titles read as beginning/ending a bounded review', function () {
    const ext = vscode.extensions.getExtension('eccentricqualitysolutions.vsc-interactive-review');
    assert.ok(ext, 'extension should be resolvable');
    const commands: { command: string; title: string }[] = ext.packageJSON.contributes.commands;
    const titleOf = (id: string) => commands.find(c => c.command === id)?.title;

    assert.strictEqual(titleOf('interactiveReview.beginReview'), 'Interactive Review: Begin review');
    assert.strictEqual(titleOf('interactiveReview.endReview'), 'Interactive Review: End review');

    // The pre-rename ids are gone for good (breaking change). Asserting their *absence*
    // is what stops a well-meaning "compatibility alias" from quietly reintroducing the
    // two-names-for-one-thing problem the rename existed to remove.
    const ids = commands.map(c => c.command);
    assert.ok(!ids.includes('interactiveReview.enable'), 'old enable ID must not be reintroduced');
    assert.ok(!ids.includes('interactiveReview.disable'), 'old disable ID must not be reintroduced');
  });

  test('the renamed commands are the ones actually registered', async () => {
    // package.json contributing an id proves nothing about registration — a rename that
    // misses `registerCommand` leaves a palette entry that throws "command not found".
    const registered = await vscode.commands.getCommands(true);
    assert.ok(registered.includes('interactiveReview.beginReview'), 'beginReview must be registered');
    assert.ok(registered.includes('interactiveReview.endReview'), 'endReview must be registered');
    assert.ok(!registered.includes('interactiveReview.enable'), 'old enable ID must not be registered');
    assert.ok(!registered.includes('interactiveReview.disable'), 'old disable ID must not be registered');
  });

  test('begin review snapshots the workspace and opens a session', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'begin.txt');
    writeFileExternally(filePath, 'original\n');

    await vscode.commands.executeCommand('interactiveReview.beginReview');

    const sm = getStateManager();
    assert.strictEqual(sm.enabled, true, 'session should be open');
    // No sleep: the promise must not resolve until the snapshot is durable.
    assert.strictEqual(
      gitGetBaseline(root, 'begin.txt'), 'original\n',
      'baseline must be on disk the moment begin-review resolves'
    );
  });

  test('end review tears the session down', async () => {
    const root = getWorkspaceRoot();
    writeFileExternally(path.join(root, 'teardown.txt'), 'content\n');
    await vscode.commands.executeCommand('interactiveReview.beginReview');
    assert.ok(gitListTracked(root).length > 0, 'precondition: something is tracked');

    await vscode.commands.executeCommand('interactiveReview.endReview');

    const sm = getStateManager();
    assert.strictEqual(sm.enabled, false, 'session should be closed');
    assert.strictEqual(sm.getAllFiles().size, 0, 'tracked state should be cleared');
    assert.strictEqual(
      fs.existsSync(path.join(root, '.vscode', 'interactive-review', 'git')), false,
      'baseline git dir should be removed'
    );
    // Teardown must not touch the user's files.
    assert.strictEqual(fs.readFileSync(path.join(root, 'teardown.txt'), 'utf-8'), 'content\n');
  });

  test('agent-invoked begin opens a walkable session (no user interaction)', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'agent-edit.txt');
    writeFileExternally(filePath, 'line one\nline two\n');

    // ── The agent turn boundary: open a review, then immediately edit. ──
    await vscode.commands.executeCommand('interactiveReview.beginReview');
    // Snapshot is complete on resolve, so an edit made right now is reviewable.
    writeFileExternally(filePath, 'line one\nAGENT ADDED\nline two\n');

    await waitForReviewing(filePath);
    const sm = getStateManager();
    assert.strictEqual(sm.getFile(filePath).baseline, 'line one\nline two\n',
      'the pre-edit content must be the baseline');

    // Walkable: the change surfaces in the queue with a pending hunk...
    const panel = getReviewPanel();
    const state = panel.panelStateForTest();
    const entry = state.files.find((f: any) => f.filePath === filePath);
    assert.ok(entry, 'agent edit should appear in the review queue');
    assert.ok(entry.pendingCount > 0, 'should have at least one pending hunk');

    // ...and walks to closure exactly like a user-initiated review. (Uses the by-path
    // entry point rather than `interactiveReview.acceptFile`, which resolves its target
    // from the active editor and so needs a focused tab this test doesn't open.)
    const { acceptFileByPath } = await import('../../commands');
    acceptFileByPath(sm, filePath, () => {});
    await sleep(200);
    const after = sm.getFile(filePath);
    assert.ok(!after || after.status !== 'reviewing', 'accepting should close out the file');
    assert.strictEqual(
      fs.readFileSync(filePath, 'utf-8'), 'line one\nAGENT ADDED\nline two\n',
      'accepted content stays on disk'
    );
  });

  test('begin review is idempotent enough to be called on an already-open session', async () => {
    const root = getWorkspaceRoot();
    writeFileExternally(path.join(root, 'twice.txt'), 'v1\n');
    await vscode.commands.executeCommand('interactiveReview.beginReview');

    // An agent may not know whether a session is already open; a second begin must not
    // throw or wedge the extension.
    await vscode.commands.executeCommand('interactiveReview.beginReview');

    assert.strictEqual(getStateManager().enabled, true, 'session should still be open');
    assert.strictEqual(gitGetBaseline(root, 'twice.txt'), 'v1\n', 'baseline should survive');
  });
});
