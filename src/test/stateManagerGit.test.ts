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

  it('a later unbaselined classification wins over an earlier witnessed create', async () => {
    // An agent creates the file and it is discarded; the user then restores their own copy,
    // and the watcher misses that create, so it surfaces as a change with no baseline. The
    // old witness must not make the user's file deletable after a Refresh.
    const file = path.join(root, 'restored.txt');
    writeFile(file, 'the user\'s content\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    sm.removeFile(file);
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }, true);

    await sm.rebuildState(ignore);

    assert.equal(sm.getFile(file)?.nullReason, 'unbaselined');
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

describe('StateManager.load keeps each null baseline\'s nullReason across a window reload', () => {
  const ignore = (fp: string) => fp.startsWith(path.join(root, '.vscode'));

  /** A window reload: a fresh StateManager loading the same repo and disk. */
  async function reload(): Promise<StateManager> {
    await sm.flush();
    const fresh = new StateManager();
    await fresh.load(ignore);
    return fresh;
  }

  // Defect: the 'unbaselined' classification lived only in memory. A reload started with
  // no record, re-adopted the file as 'created', and Discard would then delete it.
  it('an unbaselined file stays unbaselined across a reload', async () => {
    const file = path.join(root, 'preexisting.txt');
    writeFile(file, 'the user\'s content\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }, true);

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, 'unbaselined',
      'a reload must not turn a file Discard would keep into one it deletes');
  });

  it('a witnessed create stays created after a reload', async () => {
    // The other direction: new files from the previous window must stay deletable.
    const file = path.join(root, 'new.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, 'created');
  });

  // Defect: a rescan answered 'created' for any readable text file with no blob and no
  // record, so every way of losing the record was a way of deleting a user's file. The
  // shape found in review: a file ignored at Begin review, so never baselined, whose ignore
  // rule is gone by the next reload. See code-review-2026-09-20.md §5.
  it('a file with no record is never adopted as deletable', async () => {
    const file = path.join(root, 'notes', 'mine.txt');
    writeFile(file, 'the user\'s content\n');
    const ignoringNotes = (fp: string) => ignore(fp) || fp.startsWith(path.join(root, 'notes'));
    await sm.snapshotWorkspace(ignoringNotes);

    const fresh = await reload();   // the rule is gone: `reload` uses the plain `ignore`

    assert.equal(fresh.getFile(file)?.nullReason, 'unbaselined',
      'a file the user had before Begin review must not become one Discard deletes');
  });

  it('a later unbaselined classification outranks a restored witness', async () => {
    // With no record meaning 'unbaselined', the saved 'unbaselined' record only matters
    // where a witness exists too: an agent's file discarded, then the user's own copy
    // restored at the same path unseen. The witness comes back on reload; the later
    // classification must come back with it.
    const file = path.join(root, 'restored.txt');
    writeFile(file, 'the user\'s content\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    sm.removeFile(file);
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }, true);

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, 'unbaselined');
  });

  it('a later witnessed create clears the saved record', async () => {
    const file = path.join(root, 'recreated.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }, true);
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, 'created');
  });

  it('End review forgets the record, so the next session starts clean', async () => {
    // A witness from an ended session is evidence about that session only. By the next
    // Begin review the file predates the session, so it must not stay deletable.
    const file = path.join(root, 'from-last-session.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    await sm.setEnabled(false);
    await sm.setEnabled(true);

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, 'unbaselined');
  });

  // Defect: a branch switch cleared the classification in memory but left the saved record,
  // so a path it listed was restored as 'unbaselined' on the next reload even after the
  // session had since witnessed a new file being created there. Memory and a reload
  // disagreed, and Discard would keep the agent's file.
  it('a branch switch forgets the saved record as well as the in-memory one', async () => {
    const file = path.join(root, 'x.txt');
    writeFile(file, 'the user\'s content\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }, true);
    await sm.clearHunksOnBranchSwitch(ignore);
    sm.removeFile(file);   // the branch switch baselined it; e.g. an accepted deletion drops that
    await sm.flush();
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, sm.getFile(file)?.nullReason);
  });

  it('a branch switch forgets the saved witnesses', async () => {
    const file = path.join(root, 'x.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    await sm.clearHunksOnBranchSwitch(ignore);
    sm.removeFile(file);   // the branch switch baselined it; drop that so a reload adopts it
    await sm.flush();

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, 'unbaselined',
      'a create witnessed before the switch is not evidence about the new branch');
  });

  it('a damaged record is ignored rather than failing the load', async () => {
    const file = path.join(root, 'new.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    await sm.flush();
    const record = path.join(root, '.vscode', 'interactive-review', 'git', 'interactive-review-unbaselined.json');
    fs.writeFileSync(record, '{ not json');

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, 'created');
  });

  // `saveCreated` defers its write a tick; `flush` must write it, or a caller that flushes
  // and then reads the repo (every reload test here) depends on timing.
  it('flush writes a pending witness record', async () => {
    const file = path.join(root, 'new.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    await sm.flush();

    const record = path.join(root, '.vscode', 'interactive-review', 'git', 'interactive-review-created.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf-8')), ['new.txt']);
  });

  it('a damaged witness record fails safe: nothing adopted is deletable', async () => {
    const file = path.join(root, 'new.txt');
    writeFile(file, 'agent output\n');
    sm.setFile(file, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    await sm.flush();
    const record = path.join(root, '.vscode', 'interactive-review', 'git', 'interactive-review-created.json');
    fs.writeFileSync(record, '{ not json');

    const fresh = await reload();

    assert.equal(fresh.getFile(file)?.nullReason, 'unbaselined');
  });

  it('a witnessed create keeps its witness through a directory rename', async () => {
    const from = path.join(root, 'd1', 'new.txt');
    const to = path.join(root, 'd2', 'new.txt');
    writeFile(from, 'agent output\n');
    sm.setFile(from, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    fs.renameSync(path.join(root, 'd1'), path.join(root, 'd2'));
    sm.renameFile(path.join(root, 'd1'), path.join(root, 'd2'));
    // Something the user puts at the old path afterwards was never witnessed.
    writeFile(from, 'the user\'s content\n');

    const fresh = await reload();

    assert.equal(fresh.getFile(to)?.nullReason, 'created');
    assert.equal(fresh.getFile(from)?.nullReason, 'unbaselined');
  });
});

describe('StateManager: a file unreadable at Begin review', () => {
  const ignore = (fp: string) => fp.startsWith(path.join(root, '.vscode'));
  // chmod does not stop root reading, so the setup cannot produce an unreadable file there.
  const asRoot = process.getuid?.() === 0;

  // Defect: the snapshot skipped the unreadable file silently, so nothing recorded that it
  // predates the session. Once readable, a rescan saw text with no blob and adopted it as
  // 'created': a Refresh or a window reload put the user's own file in the queue as one
  // Discard deletes, while memory had no entry at all. Found by the reload property's
  // Refresh step, reasoning about what the generator could not yet reach.
  async function beginWithUnreadable(): Promise<string> {
    const file = path.join(root, 'root-owned.txt');
    writeFile(file, 'the user\'s content\n');
    fs.chmodSync(file, 0);
    try {
      await sm.snapshotWorkspace(ignore);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    await sm.flush();
    return file;
  }

  it('is never adopted as deletable by a Refresh', { skip: asRoot }, async () => {
    const file = await beginWithUnreadable();

    await sm.rebuildState(ignore);

    assert.notEqual(sm.getFile(file)?.nullReason, 'created',
      'a file the user had before Begin review must not become one Discard deletes');
  });

  it('is never adopted as deletable by a window reload', { skip: asRoot }, async () => {
    const file = await beginWithUnreadable();

    const fresh = new StateManager();
    await fresh.load(ignore);

    assert.notEqual(fresh.getFile(file)?.nullReason, 'created');
  });
});

describe('StateManager.renameFile onto a pending deletion', () => {
  const ignore = (fp: string) => fp.startsWith(path.join(root, '.vscode'));

  // Defect: the source wins, so memory drops the target's pending deletion. But when git had
  // no baseline for the source (never snapshotted, e.g. created while ignored), git's rename
  // returned early and left the deleted file's baseline at the target. A reload then showed
  // the moved file as an edit of the deleted one, and Discard would have written the deleted
  // content over it.
  it('an untracked source still replaces the target\'s baseline', async () => {
    const target = path.join(root, 'a.txt');
    writeFile(target, 'deleted soon\n');
    await sm.snapshotWorkspace(ignore);
    fs.rmSync(target);
    sm.setFile(target, { status: 'reviewing', baseline: 'deleted soon\n' }, true);
    const source = path.join(root, 'b.txt');
    writeFile(source, 'never baselined\n');

    sm.renameFile(source, target);
    fs.renameSync(source, target);
    await sm.flush();

    assert.equal(await sm.git!.getBaseline(target), undefined, 'the deleted file\'s baseline is gone');
    const fresh = new StateManager();
    await fresh.load(ignore);
    assert.equal(fresh.getFile(target)?.baseline ?? null, sm.getFile(target)?.baseline ?? null,
      'a reload agrees with memory about the target');
  });

  // Defect: an untracked source moved over an unedited, baselined file (a drag-move with
  // Replace). Its baseline was removed, so a Refresh re-adopted the moved file as 'created'
  // and Discard would have trashed it. Nothing says the moved file is new — only that git
  // had no baseline for it, which is what 'unbaselined' means.
  it('an untracked source moved over a baselined file is kept by Discard', async () => {
    const target = path.join(root, 'a.txt');
    writeFile(target, 'the user\'s file\n');
    await sm.snapshotWorkspace(ignore);
    const source = path.join(root, 'b.txt');
    writeFile(source, 'never baselined\n');

    sm.renameFile(source, target);
    fs.rmSync(target);
    fs.renameSync(source, target);
    await sm.flush();
    await sm.rebuildState(ignore);

    assert.equal(sm.getFile(target)?.nullReason, 'unbaselined');
  });

  // Since a rescan needs a witness to answer 'created', the target's own record matters only
  // where a stale witness sits at the target: an agent's file there, discarded, and then an
  // untracked file moved onto the same path.
  it('an untracked source moved onto a path with a stale witness is kept by Discard', async () => {
    const target = path.join(root, 'a.txt');
    writeFile(target, 'agent output\n');
    sm.setFile(target, { status: 'reviewing', baseline: null, nullReason: 'created' }, true);
    sm.removeFile(target);
    fs.rmSync(target);
    const source = path.join(root, 'b.txt');
    writeFile(source, 'the user\'s file\n');

    sm.renameFile(source, target);
    fs.renameSync(source, target);
    await sm.flush();
    await sm.rebuildState(ignore);

    assert.equal(sm.getFile(target)?.nullReason, 'unbaselined');
  });
});
