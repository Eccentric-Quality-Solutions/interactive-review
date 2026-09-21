import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline, sleep, waitForCondition,
  waitForReviewing, enableReview, disableReview,
  writeFileExternally, cleanWorkspace, getStateManager, openWithSelection, settle,
} from './helpers';

/** UTF-8 byte-order mark, spelled out — it is invisible in source otherwise. */
const BOM = '\uFEFF';

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

  test('acceptHunk command folds the hunk under the cursor into the baseline', async () => {
    const root = getWorkspaceRoot();
    const f = path.join(root, 'edit.txt');
    writeFileExternally(f, 'l1\nl2\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'edit.txt') !== undefined);

    writeFileExternally(f, 'l1\nl2\nl3\n'); // added line → reviewing
    await waitForReviewing(f);

    await openWithSelection(f, 2); // cursor on the added line
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

    await openWithSelection(f, 2);
    await vscode.commands.executeCommand('interactiveReview.rejectHunk');
    await sleep(300);

    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'l1\nl2\n',
      'rejecting reverts the file to the baseline');
    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing', 'file resolved');
  });

  test('rejecting the first line of a BOM file does not double the BOM', async () => {
    // The baseline keeps its BOM (it is what a restore writes back), but the replacement
    // text goes into the *document*, and VS Code re-adds the file's own BOM on save. If
    // the baseline's marker travelled with the line, the file would land on disk with two.
    const root = getWorkspaceRoot();
    const f = path.join(root, 'bom-reject.txt');
    fs.writeFileSync(f, BOM + 'l1\nl2\n', 'utf-8');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'bom-reject.txt') !== undefined);

    fs.writeFileSync(f, BOM + 'CHANGED\nl2\n', 'utf-8');
    await waitForReviewing(f);

    await openWithSelection(f, 0);
    await vscode.commands.executeCommand('interactiveReview.rejectHunk');
    await sleep(300);

    const after = fs.readFileSync(f, 'utf-8');
    assert.strictEqual(after.indexOf(BOM), 0, 'the file keeps its BOM');
    assert.strictEqual(after.indexOf(BOM, 1), -1, 'and gains no second one');
    assert.strictEqual(after, BOM + 'l1\nl2\n', 'content reverts to the baseline');
  });

  test('accepting the last hunk of a BOM file keeps the BOM in the stored baseline', async () => {
    // The mirror of the reject case above, and the direction that is easy to get wrong:
    // reject writes to the *document* (no BOM, VS Code re-adds it), accept writes to
    // *storage* (must keep it). On the last hunk the buffer becomes the new baseline —
    // and the buffer never has a BOM, so the marker has to be carried over explicitly.
    // Without that, the file's next restore-from-baseline silently drops it.
    const root = getWorkspaceRoot();
    const f = path.join(root, 'bom-accept.txt');
    fs.writeFileSync(f, BOM + 'l1\nl2\n', 'utf-8');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'bom-accept.txt') !== undefined);

    // Edit line 2, so the accepted hunk does not touch line 1 at all: any BOM loss here
    // comes from storing the buffer, not from the splice.
    fs.writeFileSync(f, BOM + 'l1\nCHANGED\n', 'utf-8');
    await waitForReviewing(f);

    await openWithSelection(f, 1);
    await vscode.commands.executeCommand('interactiveReview.acceptHunk');
    await sleep(300);

    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing', 'file resolved');
    const baseline = gitGetBaseline(root, 'bom-accept.txt');
    assert.strictEqual(baseline, BOM + 'l1\nCHANGED\n',
      'the accepted content is stored with its BOM intact');
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), BOM + 'l1\nCHANGED\n',
      'and accepting leaves the file on disk alone');
  });

  test('accepting a new BOM file keeps the BOM in the stored baseline', async () => {
    // The null-baseline case the test above cannot reach. A new file has no prior baseline
    // to carry a marker from, so the disk is the only witness — `bomFromFile` seeds it.
    // Without that, accepting the file's only hunk stores it BOM-less and the marker is
    // gone from every later restore.
    const root = getWorkspaceRoot();
    const f = path.join(root, 'bom-new.txt');
    await enableReview();

    fs.writeFileSync(f, BOM + 'brand\nnew\n', 'utf-8');
    await waitForReviewing(f);

    await openWithSelection(f, 0);
    await vscode.commands.executeCommand('interactiveReview.acceptHunk');
    await sleep(300);

    assert.notStrictEqual(getStateManager().getFile(f)?.status, 'reviewing', 'file resolved');
    assert.strictEqual(gitGetBaseline(root, 'bom-new.txt'), BOM + 'brand\nnew\n',
      'a new file’s BOM reaches the baseline');
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), BOM + 'brand\nnew\n',
      'and accepting leaves the file on disk alone');
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

    await openWithSelection(a, 1); // cursor on/after a's only hunk
    await vscode.commands.executeCommand('interactiveReview.nextHunk');
    // The command opens the next file without awaiting it, so executeCommand resolves first.
    // Wait for the editor to change rather than guessing how long that takes; the assert
    // below still reports the mismatch if it never does.
    await waitForCondition(() => vscode.window.activeTextEditor?.document.uri.fsPath === b)
      .catch(() => undefined);

    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, b,
      'no further hunk in a → advance opens the next reviewing file b');
  });

  test('commands are inert when the active editor is not a reviewing file', async () => {
    const root = getWorkspaceRoot();
    const plain = path.join(root, 'plain.txt');
    writeFileExternally(plain, 'untouched\n');
    await enableReview(); // plain becomes a baseline, not reviewing (no diff)
    await waitForCondition(() => gitGetBaseline(root, 'plain.txt') !== undefined);

    await openWithSelection(plain, 0);
    const before = fs.readFileSync(plain, 'utf-8');
    // No reviewing target → command resolves nothing and must not mutate.
    await vscode.commands.executeCommand('interactiveReview.acceptHunk');
    await vscode.commands.executeCommand('interactiveReview.rejectHunk');
    await settle();

    assert.strictEqual(fs.readFileSync(plain, 'utf-8'), before, 'no mutation on a non-reviewing file');
    assert.strictEqual(getStateManager().getFile(plain)?.status, undefined, 'plain never entered reviewing');
  });
});
