import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setTestEditors, TestDocument, TestEditor } from './__mocks__/vscode';
import { findFileDocument, findFileEditor, revealHunkPosition } from '../editorUtils';

/**
 * The contract these guard is the `scheme === 'file'` filter that `editorUtils` calls
 * load-bearing: while a review diff is open, its baseline side is a document with the SAME
 * fsPath under `interactive-review-baseline`, and a deleted file's modified side is another
 * under `interactive-review-deleted`. An unfiltered lookup by fsPath can return one of
 * those, and the callers then diff the baseline against itself — zero hunks, and the file
 * drops out of review.
 */

const FILE = '/w/src/app.ts';
const OTHER = '/w/src/other.ts';

const doc = (scheme: string, fsPath = FILE): TestDocument => ({ uri: { scheme, fsPath } });
const editor = (document: TestDocument, viewColumn: number | undefined): TestEditor =>
  ({ document, viewColumn });

describe('findFileDocument', () => {
  beforeEach(() => __setTestEditors([]));

  it('returns the editable on-disk document', () => {
    const wanted = doc('file');
    __setTestEditors([doc('interactive-review-baseline'), wanted]);
    assert.equal(findFileDocument(FILE), wanted as never);
  });

  it('never returns the baseline document that shares the path', () => {
    __setTestEditors([doc('interactive-review-baseline')]);
    assert.equal(findFileDocument(FILE), undefined);
  });

  it('never returns the empty deleted-side document that shares the path', () => {
    __setTestEditors([doc('interactive-review-deleted')]);
    assert.equal(findFileDocument(FILE), undefined);
  });

  it('is undefined when the file is not open', () => {
    __setTestEditors([doc('file', OTHER)]);
    assert.equal(findFileDocument(FILE), undefined);
  });
});

describe('findFileEditor', () => {
  beforeEach(() => __setTestEditors([]));

  it('prefers the diff\'s embedded modified pane over a normal editor', () => {
    const embedded = editor(doc('file'), undefined);
    __setTestEditors([], [editor(doc('file'), 1), embedded]);
    assert.equal(findFileEditor(FILE), embedded as never);
  });

  it('falls back to a normal editor when no diff pane is visible', () => {
    const normal = editor(doc('file'), 1);
    __setTestEditors([], [normal]);
    assert.equal(findFileEditor(FILE), normal as never);
  });

  it('never returns the baseline pane, even though it has no viewColumn either', () => {
    const normal = editor(doc('file'), 1);
    __setTestEditors([], [editor(doc('interactive-review-baseline'), undefined), normal]);
    assert.equal(findFileEditor(FILE), normal as never);
  });

  it('is undefined when only the baseline pane is visible', () => {
    __setTestEditors([], [editor(doc('interactive-review-baseline'), undefined)]);
    assert.equal(findFileEditor(FILE), undefined);
  });
});

describe('revealHunkPosition', () => {
  /** Records what the editor was asked to select and reveal. */
  function fakeEditor() {
    return {
      selection: undefined as { active: { line: number } } | undefined,
      revealed: undefined as { start: { line: number } } | undefined,
      revealRange(range: { start: { line: number } }) { this.revealed = range; },
    };
  }

  it('lands on the hunk\'s start line, converting 1-based to 0-based', () => {
    const e = fakeEditor();
    revealHunkPosition(e as never, 12);
    assert.equal(e.selection?.active.line, 11);
    assert.equal(e.revealed?.start.line, 11);
  });

  it('clamps a hunk at the top of the file to line 0 rather than going negative', () => {
    const e = fakeEditor();
    revealHunkPosition(e as never, 0);
    assert.equal(e.selection?.active.line, 0);
    assert.equal(e.revealed?.start.line, 0);
  });
});
