import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaselineGit } from '../baselineGit';
import { normalizePath } from '../pathNormalize';

let tmpDir: string;
let stateDir: string;
let git: BaselineGit;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-test-'));
  stateDir = path.join(tmpDir, '.vscode', 'interactive-review');
  git = new BaselineGit(stateDir, tmpDir);
  await git.initGit();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BaselineGit', () => {
  describe('initGit', () => {
    it('creates the git directory', () => {
      assert.ok(fs.existsSync(path.join(stateDir, 'git')));
    });

    it('is idempotent — calling twice does not throw', async () => {
      await git.initGit();
      assert.ok(fs.existsSync(path.join(stateDir, 'git')));
    });
  });

  describe('snapshot / getBaseline', () => {
    it('returns undefined for untracked file', async () => {
      const result = await git.getBaseline(path.join(tmpDir, 'nonexistent.txt'));
      assert.equal(result, undefined);
    });

    it('stores and retrieves content', async () => {
      const filePath = path.join(tmpDir, 'hello.txt');
      await git.snapshot(filePath, 'hello world\n');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, 'hello world\n');
    });

    it('overwrites previous snapshot', async () => {
      const filePath = path.join(tmpDir, 'update.txt');
      await git.snapshot(filePath, 'v1\n');
      await git.snapshot(filePath, 'v2\n');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, 'v2\n');
    });

    it('handles empty content', async () => {
      const filePath = path.join(tmpDir, 'empty.txt');
      await git.snapshot(filePath, '');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, '');
    });

    it('handles multi-line content', async () => {
      const filePath = path.join(tmpDir, 'multi.txt');
      const content = 'line1\nline2\nline3\n';
      await git.snapshot(filePath, content);
      assert.equal(await git.getBaseline(filePath), content);
    });

    it('handles content with special characters', async () => {
      const filePath = path.join(tmpDir, 'special.txt');
      const content = 'hello "world" & <foo>\n';
      await git.snapshot(filePath, content);
      assert.equal(await git.getBaseline(filePath), content);
    });
  });

  describe('snapshotBatch', () => {
    it('snapshots multiple files atomically', async () => {
      const files = [
        { filePath: path.join(tmpDir, 'batch1.txt'), content: 'batch1\n' },
        { filePath: path.join(tmpDir, 'batch2.txt'), content: 'batch2\n' },
        { filePath: path.join(tmpDir, 'batch3.txt'), content: 'batch3\n' },
      ];
      await git.snapshotBatch(files);
      for (const { filePath, content } of files) {
        assert.equal(await git.getBaseline(filePath), content);
      }
    });

    it('is a no-op for empty array', async () => {
      await git.snapshotBatch([]);
    });

    it('getBaseline is immediately available after snapshotBatch', async () => {
      const filePath = path.join(tmpDir, 'immediate.txt');
      await git.snapshotBatch([{ filePath, content: 'immediate\n' }]);
      // Must be readable right away without any extra commit
      assert.equal(await git.getBaseline(filePath), 'immediate\n');
    });

    it('snapshot after snapshotBatch does not lose batch files from HEAD', async () => {
      // Reproduce: snapshotBatch adds fileA, then snapshot adds fileB.
      // After both commits, fileA must still be in HEAD (listTrackedFiles).
      const fileA = path.join(tmpDir, 'batch-persist-a.txt');
      const fileB = path.join(tmpDir, 'batch-persist-b.txt');
      await git.snapshotBatch([{ filePath: fileA, content: 'aaa\n' }]);
      await git.snapshot(fileB, 'bbb\n');
      const tracked = await git.listTrackedFiles();
      assert.ok(tracked.includes(fileA), `fileA should be in HEAD after subsequent snapshot (tracked: ${tracked.join(', ')})`);
      assert.ok(tracked.includes(fileB), `fileB should be in HEAD`);
      assert.equal(await git.getBaseline(fileA), 'aaa\n');
      assert.equal(await git.getBaseline(fileB), 'bbb\n');
    });

    it('snapshotBatch after snapshotBatch preserves all files in HEAD', async () => {
      const fileC = path.join(tmpDir, 'batch2-c.txt');
      const fileD = path.join(tmpDir, 'batch2-d.txt');
      await git.snapshotBatch([{ filePath: fileC, content: 'ccc\n' }]);
      await git.snapshotBatch([{ filePath: fileD, content: 'ddd\n' }]);
      const tracked = await git.listTrackedFiles();
      assert.ok(tracked.includes(fileC), 'fileC from first batch should persist after second batch');
      assert.ok(tracked.includes(fileD), 'fileD from second batch should be present');
    });
  });

  describe('removeFile', () => {
    it('removes a tracked file', async () => {
      const filePath = path.join(tmpDir, 'toremove.txt');
      await git.snapshot(filePath, 'remove me\n');
      assert.notEqual(await git.getBaseline(filePath), undefined);
      await git.removeFile(filePath);
      assert.equal(await git.getBaseline(filePath), undefined);
    });

    it('is a no-op for untracked file', async () => {
      const filePath = path.join(tmpDir, 'never-tracked.txt');
      await git.removeFile(filePath); // should not throw
    });
  });

  describe('removeFileBatch', () => {
    it('removes multiple tracked files in one operation', async () => {
      const file1 = path.join(tmpDir, 'batch-rm-1.txt');
      const file2 = path.join(tmpDir, 'batch-rm-2.txt');
      const file3 = path.join(tmpDir, 'batch-rm-3.txt');
      await git.snapshotBatch([
        { filePath: file1, content: 'a\n' },
        { filePath: file2, content: 'b\n' },
        { filePath: file3, content: 'c\n' },
      ]);
      assert.equal(await git.getBaseline(file1), 'a\n');
      assert.equal(await git.getBaseline(file2), 'b\n');
      assert.equal(await git.getBaseline(file3), 'c\n');
      await git.removeFileBatch([file1, file2, file3]);
      assert.equal(await git.getBaseline(file1), undefined);
      assert.equal(await git.getBaseline(file2), undefined);
      assert.equal(await git.getBaseline(file3), undefined);
    });

    it('is a no-op for empty array', async () => {
      await git.removeFileBatch([]); // should not throw
    });

    it('leaves unrelated files intact', async () => {
      const keep = path.join(tmpDir, 'batch-rm-keep.txt');
      const remove = path.join(tmpDir, 'batch-rm-gone.txt');
      await git.snapshotBatch([
        { filePath: keep, content: 'keep\n' },
        { filePath: remove, content: 'gone\n' },
      ]);
      await git.removeFileBatch([remove]);
      assert.equal(await git.getBaseline(keep), 'keep\n');
      assert.equal(await git.getBaseline(remove), undefined);
    });
  });

  describe('renameFile', () => {
    it('moves baseline from old path to new path', async () => {
      const oldPath = path.join(tmpDir, 'rename-old.txt');
      const newPath = path.join(tmpDir, 'rename-new.txt');
      await git.snapshot(oldPath, 'rename content\n');
      await git.renameFile(oldPath, newPath);
      assert.equal(await git.getBaseline(newPath), 'rename content\n');
      assert.equal(await git.getBaseline(oldPath), undefined);
    });

    it('preserves content for a file that was already reviewing', async () => {
      const oldPath = path.join(tmpDir, 'reviewing-old.txt');
      const newPath = path.join(tmpDir, 'reviewing-new.txt');
      const content = 'line1\nline2\nline3\n';
      await git.snapshot(oldPath, content);
      await git.renameFile(oldPath, newPath);
      assert.equal(await git.getBaseline(newPath), content);
    });

    it('works for new file (empty baseline)', async () => {
      const oldPath = path.join(tmpDir, 'new-old.txt');
      const newPath = path.join(tmpDir, 'new-new.txt');
      await git.snapshot(oldPath, '');
      await git.renameFile(oldPath, newPath);
      assert.equal(await git.getBaseline(newPath), '');
      assert.equal(await git.getBaseline(oldPath), undefined);
    });

    it('is a no-op for untracked file', async () => {
      const oldPath = path.join(tmpDir, 'untracked-rename.txt');
      const newPath = path.join(tmpDir, 'untracked-rename-new.txt');
      await git.renameFile(oldPath, newPath); // should not throw
      assert.equal(await git.getBaseline(newPath), undefined);
    });

    it('does not affect other tracked files', async () => {
      const other = path.join(tmpDir, 'rename-other.txt');
      const oldPath = path.join(tmpDir, 'rename-move-old.txt');
      const newPath = path.join(tmpDir, 'rename-move-new.txt');
      await git.snapshot(other, 'other\n');
      await git.snapshot(oldPath, 'moving\n');
      await git.renameFile(oldPath, newPath);
      assert.equal(await git.getBaseline(other), 'other\n');
      assert.equal(await git.getBaseline(newPath), 'moving\n');
    });

    it('renamed file appears in listTrackedFiles with new path', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-rename-list-'));
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      await g2.initGit();
      const oldPath = path.join(dir2, 'a.txt');
      const newPath = path.join(dir2, 'b.txt');
      await g2.snapshot(oldPath, 'content\n');
      await g2.renameFile(oldPath, newPath);
      const tracked = await g2.listTrackedFiles();
      assert.ok(tracked.includes(newPath));
      assert.ok(!tracked.includes(oldPath));
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  describe('listTrackedFiles', () => {
    it('returns empty when nothing tracked', async () => {
      // fresh instance to avoid interference
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-list-'));
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      await g2.initGit();
      const files = await g2.listTrackedFiles();
      assert.deepEqual(files, []);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('returns tracked file paths', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-list2-'));
      const root = dir2;
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), root);
      await g2.initGit();
      const f1 = path.join(root, 'a.txt');
      const f2 = path.join(root, 'b.txt');
      await g2.snapshotBatch([
        { filePath: f1, content: 'a\n' },
        { filePath: f2, content: 'b\n' },
      ]);
      const tracked = await g2.listTrackedFiles();
      assert.ok(tracked.includes(f1));
      assert.ok(tracked.includes(f2));
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('handles non-ASCII file paths correctly', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-nonascii-'));
      const root = dir2;
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), root);
      await g2.initGit();
      const f1 = path.join(root, 'メール一覧.xlsx');
      const f2 = path.join(root, 'sub', '日本語ファイル.txt');
      fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
      await g2.snapshotBatch([
        { filePath: f1, content: 'content1\n' },
        { filePath: f2, content: 'content2\n' },
      ]);
      const tracked = await g2.listTrackedFiles();
      assert.ok(tracked.includes(f1), `tracked should include ${f1}, got: ${tracked}`);
      assert.ok(tracked.includes(f2), `tracked should include ${f2}, got: ${tracked}`);
      // getBaseline should also work with non-ASCII paths
      const baseline = await g2.getBaseline(f1);
      assert.strictEqual(baseline, 'content1\n');
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('snapshot and listTrackedFiles agree on Unicode form (NFD→NFC on macOS, identity elsewhere)', async () => {
      // A path can reach us as NFD (macOS readdir) while git ls-tree returns NFC. The
      // invariant: snapshot, listTrackedFiles, getBaseline, and removeFile all agree on the
      // *same* form so Set/Map lookups match — they must, because each routes the path
      // through normalizePath(). That form is NFC on macOS (core.precomposeUnicode) and
      // identity on Linux, where NFD and NFC are distinct filenames and normalizing would
      // conflate them. This asserts the agreement, not a hard-coded form, so it passes on
      // both platforms.
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-nfc-'));
      const root = dir2;
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), root);
      await g2.initGit();
      // が in NFD = か (U+304B) + combining dakuten (U+3099)
      const nfdName = '\u304b\u3099\u30c8\u3099.txt'; // がド.txt in NFD
      const nfcName = nfdName.normalize('NFC');           // がド.txt in NFC
      assert.notStrictEqual(nfdName, nfcName, 'test sanity: NFD and NFC should differ');
      const nfdPath = path.join(root, nfdName);
      // Snapshot with NFD path (simulating filesystem path)
      await g2.snapshot(nfdPath, 'hello\n');
      const tracked = await g2.listTrackedFiles();
      // listTrackedFiles reports the path in the same normalized form snapshot stored it in.
      const expectedPath = normalizePath(nfdPath);
      assert.ok(tracked.includes(expectedPath), `tracked should include ${expectedPath}, got: ${tracked}`);
      // getBaseline with the original NFD path resolves (normalized internally to match).
      const baseline = await g2.getBaseline(nfdPath);
      assert.strictEqual(baseline, 'hello\n');
      // removeFile with the original NFD path resolves the same tracked entry.
      await g2.removeFile(nfdPath);
      const tracked2 = await g2.listTrackedFiles();
      assert.strictEqual(tracked2.length, 0);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('renameFile handles directory renames', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-dirren-'));
      const root = dir2;
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), root);
      await g2.initGit();
      const oldDir = path.join(root, 'oldDir');
      const newDir = path.join(root, 'newDir');
      fs.mkdirSync(oldDir, { recursive: true });
      const f1 = path.join(oldDir, 'a.txt');
      const f2 = path.join(oldDir, 'b.txt');
      await g2.snapshotBatch([
        { filePath: f1, content: 'aaa\n' },
        { filePath: f2, content: 'bbb\n' },
      ]);
      // Rename directory
      await g2.renameFile(oldDir, newDir);
      const tracked = await g2.listTrackedFiles();
      assert.ok(!tracked.some(fp => fp.includes('oldDir')), `no old paths: ${tracked}`);
      assert.ok(tracked.includes(path.join(newDir, 'a.txt')), `tracked a.txt under newDir: ${tracked}`);
      assert.ok(tracked.includes(path.join(newDir, 'b.txt')), `tracked b.txt under newDir: ${tracked}`);
      // Baselines should be accessible under new paths
      assert.strictEqual(await g2.getBaseline(path.join(newDir, 'a.txt')), 'aaa\n');
      assert.strictEqual(await g2.getBaseline(path.join(newDir, 'b.txt')), 'bbb\n');
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  describe('settings', () => {
    it('returns defaults when no settings file exists', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-settings-'));
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      const s = g2.loadSettings();
      const expectedDefaults = process.platform === 'darwin' ? ['.git', '.DS_Store'] : ['.git'];
      assert.deepEqual(s.ignorePatterns, expectedDefaults);
      assert.equal(s.respectGitignore, true);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('round-trips settings', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-settings2-'));
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      g2.saveSettings({ ignorePatterns: ['node_modules', 'dist'], respectGitignore: false, clearOnBranchSwitch: false, quoteRotationInterval: 60 });
      const s = g2.loadSettings();
      assert.deepEqual(s.ignorePatterns, ['node_modules', 'dist']);
      assert.equal(s.respectGitignore, false);
      assert.equal(s.quoteRotationInterval, 60);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('round-trips quoteRotationInterval set to 0', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-settings-qri0-'));
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      g2.saveSettings({ ignorePatterns: ['.git'], respectGitignore: true, clearOnBranchSwitch: false, quoteRotationInterval: 0 });
      const s = g2.loadSettings();
      assert.equal(s.quoteRotationInterval, 0);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('round-trips quoteRotationInterval with custom value', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-settings-qri-'));
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      g2.saveSettings({ ignorePatterns: ['.git'], respectGitignore: true, clearOnBranchSwitch: false, quoteRotationInterval: 30 });
      const s = g2.loadSettings();
      assert.equal(s.quoteRotationInterval, 30);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('loadSettings defaults quoteRotationInterval when missing from file', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-settings-qri-missing-'));
      fs.mkdirSync(path.join(dir2, '.vscode', 'interactive-review'), { recursive: true });
      fs.writeFileSync(
        path.join(dir2, '.vscode', 'interactive-review', 'settings.json'),
        JSON.stringify({ ignorePatterns: ['.git'], respectGitignore: true, clearOnBranchSwitch: false }),
        'utf-8'
      );
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      const s = g2.loadSettings();
      assert.equal(s.quoteRotationInterval, 30);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('mergeDefaultSettings fills missing fields', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-merge-'));
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      // Write partial settings (no respectGitignore, no quoteRotationInterval)
      fs.mkdirSync(path.join(dir2, '.vscode', 'interactive-review'), { recursive: true });
      fs.writeFileSync(
        path.join(dir2, '.vscode', 'interactive-review', 'settings.json'),
        JSON.stringify({ ignorePatterns: ['dist'] }),
        'utf-8'
      );
      const merged = g2.mergeDefaultSettings({ ignorePatterns: ['.git'], respectGitignore: true, clearOnBranchSwitch: false, quoteRotationInterval: 30 });
      // Existing value preserved
      assert.deepEqual(merged.ignorePatterns, ['dist']);
      // Missing fields filled from defaults
      assert.equal(merged.respectGitignore, true);
      assert.equal(merged.quoteRotationInterval, 30);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('mergeDefaultSettings preserves all existing fields', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-merge2-'));
      const g2 = new BaselineGit(path.join(dir2, '.vscode', 'interactive-review'), dir2);
      g2.saveSettings({ ignorePatterns: ['custom'], respectGitignore: false, clearOnBranchSwitch: false, quoteRotationInterval: 30 });
      const merged = g2.mergeDefaultSettings({ ignorePatterns: ['.git'], respectGitignore: true, clearOnBranchSwitch: false, quoteRotationInterval: 60 });
      assert.deepEqual(merged.ignorePatterns, ['custom']);
      assert.equal(merged.respectGitignore, false);
      assert.equal(merged.quoteRotationInterval, 30);
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  describe('destroyGit', () => {
    it('removes the git directory', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-destroy-'));
      const hDir = path.join(dir2, '.vscode', 'interactive-review');
      const g2 = new BaselineGit(hDir, dir2);
      await g2.initGit();
      assert.ok(fs.existsSync(path.join(hDir, 'git')));
      g2.destroyGit();
      assert.ok(!fs.existsSync(path.join(hDir, 'git')));
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('preserves settings.json after destroy', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-review-destroy2-'));
      const hDir = path.join(dir2, '.vscode', 'interactive-review');
      const g2 = new BaselineGit(hDir, dir2);
      await g2.initGit();
      g2.saveSettings({ ignorePatterns: ['dist'], respectGitignore: false, clearOnBranchSwitch: false, quoteRotationInterval: 60 });
      g2.destroyGit();
      assert.ok(fs.existsSync(path.join(hDir, 'settings.json')));
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });
});
