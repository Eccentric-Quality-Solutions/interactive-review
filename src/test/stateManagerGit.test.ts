import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateManager } from '../stateManager';

declare const global: Record<string, unknown>;

/**
 * StateManager against a REAL baseline git repo, at unit-test speed.
 *
 * The vscode mock drives `workspaceFolders` from `global.__reviewTestRoot`, so a
 * StateManager rooted at a temp directory gets a genuine BaselineGit underneath it. That
 * is the layer where "memory and the baseline repo disagree" defects live, and it is far
 * cheaper and more deterministic than reaching it through the integration suite.
 *
 * Each regression test here was checked to FAIL against the code before its fix.
 */

let root: string;
let sm: StateManager;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-smgit-'));
  global.__reviewTestRoot = root;
  sm = new StateManager();
  await sm.setEnabled(true);
});

afterEach(async () => {
  await sm.flush();
  fs.rmSync(root, { recursive: true, force: true });
});

const rel = (fp: string) => path.relative(root, fp).split(path.sep).join('/');

function writeFile(fp: string, content: string): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

describe('StateManager.removePathAndChildren', () => {
  // Defect: an Explorer folder delete called removeFile(<dir>), which git turns into a
  // successful no-op (see baselineGitHardening.test.ts). Every file under the folder kept
  // its baseline, so the next Refresh or window reload resurrected the whole folder as
  // pending deletions the user had already carried out.
  //
  // The children that matter most are the ones never edited: they have a baseline in git
  // but no entry in memory, so an in-memory sweep alone cannot find them.
  it('removes every baseline under the directory, including files never edited', async () => {
    const git = sm.git!;
    await git.snapshotBatch([
      { filePath: path.join(root, 'd', 'a.txt'), content: 'a\n' },
      { filePath: path.join(root, 'd', 'nested', 'b.txt'), content: 'b\n' },
      { filePath: path.join(root, 'e.txt'), content: 'e\n' },
    ]);

    sm.removePathAndChildren(path.join(root, 'd'));
    await sm.flush();

    const tracked = (await git.listTrackedFiles()).map(rel).sort();
    assert.deepEqual(tracked, ['e.txt'], 'only the sibling outside the deleted directory survives');
  });

  it('drops in-memory review entries under the directory, and only those', () => {
    const inside = path.join(root, 'd', 'a.txt');
    const outside = path.join(root, 'e.txt');
    sm.setFile(inside, { status: 'reviewing', baseline: 'old\n' }, true);
    sm.setFile(outside, { status: 'reviewing', baseline: 'old\n' }, true);

    sm.removePathAndChildren(path.join(root, 'd'));

    assert.equal(sm.getFile(inside), undefined);
    assert.equal(sm.getFile(outside)?.status, 'reviewing');
  });

  it('does not treat a sibling that merely shares the prefix as a child', async () => {
    // `d` must not swallow `dx/` — a naive startsWith(dirPath) would.
    const git = sm.git!;
    await git.snapshotBatch([
      { filePath: path.join(root, 'd', 'a.txt'), content: 'a\n' },
      { filePath: path.join(root, 'dx', 'keep.txt'), content: 'k\n' },
    ]);

    sm.removePathAndChildren(path.join(root, 'd'));
    await sm.flush();

    assert.deepEqual((await git.listTrackedFiles()).map(rel), ['dx/keep.txt']);
  });

  it('removes a plain file path too, since the caller cannot tell file from directory', async () => {
    // The file is already gone from disk when the delete event arrives, so onDiskDelete
    // cannot stat it. The method must handle both shapes.
    const git = sm.git!;
    const file = path.join(root, 'solo.txt');
    await git.snapshot(file, 's\n');

    sm.removePathAndChildren(file);
    await sm.flush();

    assert.equal(await git.getBaseline(file), undefined);
  });
});

describe('StateManager.snapshotWorkspace', () => {
  // Defect: a failed snapshot was reported here and then swallowed, so callers carried on as
  // if it had worked. `recoverLostBaseline` sets `rebuilt = true` on the next line and
  // announced "a fresh baseline has been taken" beside the failure message, and Begin review
  // resolved successfully for an agent that was about to start editing against no baseline.
  //
  // The failure is injected by replacing the object database with a regular file, so
  // `git hash-object -w` cannot write. That works regardless of uid, unlike chmod.
  it('rejects when the baseline cannot be written', async () => {
    writeFile(path.join(root, 'doomed.txt'), 'content\n');
    const objects = path.join(root, '.vscode', 'interactive-review', 'git', 'objects');
    fs.rmSync(objects, { recursive: true, force: true });
    fs.writeFileSync(objects, 'not a directory');

    await assert.rejects(
      () => sm.snapshotWorkspace(fp => fp.startsWith(sm.dir!)),
      'a snapshot that cannot write must reject, not resolve as if it had worked',
    );
  });

  it('resolves and records a baseline when the snapshot succeeds', async () => {
    // The other direction, so the test above cannot pass by rejecting unconditionally.
    const file = path.join(root, 'fine.txt');
    writeFile(file, 'content\n');

    await sm.snapshotWorkspace(fp => fp.startsWith(sm.dir!));

    assert.equal(await sm.git!.getBaseline(file), 'content\n');
  });
});

describe('StateManager End review / Begin review overlap', () => {
  const ignore = (fp: string) => fp.startsWith(path.join(root, '.vscode'));

  // Defect: End review waits for queued git writes before deleting the repo, and a Begin
  // review arriving in that wait found End's instance still attached, snapshotted into it,
  // and then lost the repo when End resumed and deleted it — resolving as if the session
  // were open, with no baseline on disk.
  it('a Begin review during End review\'s drain keeps its own baseline repo', async () => {
    const file = path.join(root, 'a.txt');
    writeFile(file, 'v1\n');
    await sm.snapshotWorkspace(ignore);
    sm.snapshotFile(file, 'queued\n');   // a write End must drain before tearing down

    const end = sm.setEnabled(false);
    const begin = (async () => {
      await sm.setEnabled(true);
      await sm.snapshotWorkspace(ignore);
    })();
    await Promise.all([end, begin]);
    await sm.flush();

    assert.equal(sm.enabled, true);
    assert.ok(sm.git, 'the new session has a baseline repo');
    assert.equal(await sm.git!.getBaseline(file), 'v1\n', 'and the Begin snapshot is in it');
    assert.equal(sm.getAllFiles().size, 0);
  });

  // Defect: a Begin waiting out End's drain resumed without noticing that a second End had
  // arrived meanwhile, then created and snapshotted a repo for the ended session. `load()`
  // reads an existing repo as "review is on", so the next window reload reopened it.
  it('a Begin overtaken by a second End review leaves no repo behind', async () => {
    const file = path.join(root, 'a.txt');
    writeFile(file, 'v1\n');
    await sm.snapshotWorkspace(ignore);
    sm.snapshotFile(file, 'queued\n');   // keeps the first End draining

    const end1 = sm.setEnabled(false);
    const begin = (async () => {
      await sm.setEnabled(true);
      await sm.snapshotWorkspace(ignore);
    })();
    const end2 = sm.setEnabled(false);
    await Promise.all([end1, begin, end2]);
    await sm.flush();

    assert.equal(sm.enabled, false);
    assert.equal(sm.git, undefined, 'no baseline repo attached to an ended session');
    assert.equal(fs.existsSync(path.join(root, '.vscode', 'interactive-review', 'git')), false,
      'and none on disk for the next load() to reopen');
  });

  it('changes the session on every Begin and End review', async () => {
    const opened = sm.session;
    await sm.setEnabled(false);
    const closed = sm.session;
    await sm.setEnabled(true);
    assert.notEqual(closed, opened);
    assert.notEqual(sm.session, closed);
  });
});

describe('StateManager.rebuildState keeps each null baseline\'s nullReason', () => {
  const ignore = (fp: string) => fp.startsWith(path.join(root, '.vscode'));

  // Defect: Refresh clears memory and re-adopts every untracked readable file as 'created',
  // the value that licenses Discard to delete it. A file the session had deliberately marked
  // 'unbaselined' (a change with no baseline and no evidence of a create) became deletable
  // after one Refresh. See code-review-2026-09-20.md §1.2.
  it('an unbaselined file stays unbaselined across a Refresh', async () => {
    const file = path.join(root, 'preexisting.txt');
    writeFile(file, 'the user\'s content\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }, true);

    await sm.rebuildState(ignore);

    assert.equal(sm.getFile(file)?.nullReason, 'unbaselined',
      'a Refresh must not turn a file Discard would keep into one it deletes');
  });

  it('a witnessed create stays created across a Refresh', async () => {
    // The other direction, so the test above cannot pass by adopting everything as unbaselined.
    const file = path.join(root, 'new.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);

    await sm.rebuildState(ignore);

    assert.equal(sm.getFile(file)?.nullReason, 'created');
  });

  it('a witnessed create wins over an earlier unbaselined classification', async () => {
    const file = path.join(root, 'recreated.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }, true);
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);

    await sm.rebuildState(ignore);

    assert.equal(sm.getFile(file)?.nullReason, 'created');
  });

  it('the unbaselined classification follows a rename', async () => {
    const from = path.join(root, 'before.txt');
    const to = path.join(root, 'after.txt');
    writeFile(from, 'the user\'s content\n');
    sm.setFile(from, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }, true);
    fs.renameSync(from, to);
    sm.renameFile(from, to);
    await sm.flush();

    await sm.rebuildState(ignore);

    assert.equal(sm.getFile(to)?.nullReason, 'unbaselined');
  });
});
