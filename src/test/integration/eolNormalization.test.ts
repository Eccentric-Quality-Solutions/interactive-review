import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import { getWorkspaceRoot, writeFileExternally, cleanWorkspace } from './helpers';

/**
 * `discardHunk` restores baseline lines with `originalLines.join('\n') + '\n'`
 * (src/commands.ts), and `replaceEntireDocument` writes the whole baseline back the same
 * way — neither consults `doc.eol`. That is only safe because VSCode normalizes the text of
 * an applied edit to the model's own EOL, so LF text written into a CRLF document comes
 * back as CRLF.
 *
 * The assumption is invisible at both call sites and nothing else would catch it breaking:
 * if VSCode stopped normalizing, every discard in a CRLF file would leave lines whose only
 * difference from the baseline is a missing `\r` — and since `computeHunks` is now
 * EOL-insensitive, the resulting corruption would not even show up as a pending hunk. It
 * would silently rewrite the user's line endings.
 *
 * This was a real open question, not a hypothetical: a review flagged the LF join as a
 * CRLF bug on a reading of the source alone. It is not one, and this test is the evidence.
 */
suite('EOL normalization assumption', function () {
  this.timeout(30000);

  setup(function () { cleanWorkspace(); });
  teardown(function () { cleanWorkspace(); });

  test('a WorkspaceEdit inserting LF text into a CRLF document is normalized to CRLF', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'crlf.txt');
    writeFileExternally(filePath, 'a\r\nb\r\nc\r\n');

    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.eol, vscode.EndOfLine.CRLF, 'document should open as CRLF');

    // Exactly the shape discardHunk applies: replace a line range with `lines.join('\n') + '\n'`.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(new vscode.Position(1, 0), new vscode.Position(2, 0)), 'B\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'edit should apply');

    assert.strictEqual(doc.eol, vscode.EndOfLine.CRLF, 'document should still be CRLF after the edit');
    assert.strictEqual(
      doc.getText(), 'a\r\nB\r\nc\r\n',
      'LF text in the edit must be normalized to the document EOL, not inserted verbatim'
    );
  });
});
