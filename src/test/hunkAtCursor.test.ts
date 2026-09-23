import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { hunkAtCursor } from '../commands';
import type { FileState } from '../types';

/**
 * `hunkAtCursor` resolves the target for the accept and reject *keybindings* — the two
 * commands that rewrite the file with no click to aim them. It used to wrap to `hunks[0]`
 * when the cursor sat past every hunk, so pressing accept below the last change silently
 * resolved a hunk scrolled off the top of the screen: the file changed, and nothing on
 * screen explained why. These pin the no-wrap behaviour that replaced it.
 */

const baseline = 'a\nb\nc\nd\ne\nf\ng\n';
const current = 'a\nB\nc\nd\ne\nF\ng\n';  // two hunks: line 2 and line 6

const fileState: FileState = { status: 'reviewing', baseline };

/** The slice of TextEditor `hunkAtCursor` actually reads. */
const editorAtLine = (line0: number): vscode.TextEditor => ({
  document: { getText: () => current },
  selection: { active: { line: line0 } },
} as unknown as vscode.TextEditor);

describe('hunkAtCursor', () => {
  it('resolves the hunk the cursor sits inside', () => {
    assert.equal(hunkAtCursor(editorAtLine(1), fileState)?.newStart, 2);
  });

  it('falls forward to the next hunk from a context line', () => {
    // line0 3 → 1-based 4, between the two hunks: the one at/after it is the line-6 hunk.
    assert.equal(hunkAtCursor(editorAtLine(3), fileState)?.newStart, 6);
  });

  it('does not wrap to the first hunk when the cursor is past every hunk', () => {
    // line0 6 → 1-based 7, below both hunks. The old `?? hunks[0]` answered the line-2
    // hunk here, which is off-screen from wherever the user actually was.
    assert.equal(hunkAtCursor(editorAtLine(6), fileState), undefined);
  });

  it('resolves the first hunk when the cursor is above every hunk', () => {
    // Still lands, because `hunkAtLine` falls *forward*. Only the backwards wrap is gone.
    assert.equal(hunkAtCursor(editorAtLine(0), fileState)?.newStart, 2);
  });

  it('answers undefined when there is nothing pending', () => {
    assert.equal(hunkAtCursor(editorAtLine(0), { status: 'reviewing', baseline: current }), undefined);
  });
});
