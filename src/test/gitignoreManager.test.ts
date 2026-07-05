import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// gitignoreManager uses vscode.workspace.workspaceFolders.
// The node_modules/vscode stub reads from global.__reviewTestRoot.
declare const global: Record<string, unknown>;

import { upsertGitignore, removeGitignore } from '../gitignoreManager';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-gitignore-'));
  global.__reviewTestRoot = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  global.__reviewTestRoot = undefined;
});

describe('upsertGitignore', () => {
  it('creates .gitignore when none exists', () => {
    upsertGitignore();
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    assert.ok(content.includes('.vscode/interactive-review/'));
  });

  it('appends entry to existing .gitignore', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules\n', 'utf-8');
    upsertGitignore();
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(content.includes('node_modules'));
    assert.ok(content.includes('.vscode/interactive-review/'));
  });

  it('is idempotent — does not duplicate entry', () => {
    upsertGitignore();
    upsertGitignore();
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    const count = (content.match(/\.vscode\/interactive-review\//g) ?? []).length;
    assert.equal(count, 1);
  });

  it('adds newline separator when existing file lacks trailing newline', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules', 'utf-8');
    upsertGitignore();
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(content.includes('\n.vscode/interactive-review/'));
  });

  it('does nothing when no workspace root', () => {
    global.__reviewTestRoot = undefined;
    upsertGitignore(); // should not throw
  });
});

describe('removeGitignore', () => {
  it('removes the interactive-review entry', () => {
    upsertGitignore();
    removeGitignore();
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    assert.ok(!content.includes('.vscode/interactive-review/'));
  });

  it('preserves other entries', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules\ndist\n', 'utf-8');
    upsertGitignore();
    removeGitignore();
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(content.includes('node_modules'));
    assert.ok(content.includes('dist'));
  });

  it('is a no-op when .gitignore does not exist', () => {
    removeGitignore(); // should not throw
  });

  it('is a no-op when entry is not present', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules\n', 'utf-8');
    removeGitignore();
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(content.includes('node_modules'));
  });

  it('does nothing when no workspace root', () => {
    global.__reviewTestRoot = undefined;
    removeGitignore(); // should not throw
  });
});
