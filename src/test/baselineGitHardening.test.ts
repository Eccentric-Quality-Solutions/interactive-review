import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { BaselineGit } from '../baselineGit';

/**
 * Regression guards for the baseline repo's contract with git.
 *
 * Every test here pins a defect that shipped, and each one was checked to FAIL against the
 * code as it stood before its fix — a regression test that passes on the broken code is
 * decoration. See docs/test-strategy.md for the rule and
 * `git show 0e7c707:docs/code-review-2026-09-20.md` for the defects.
 *
 * The shared theme: the baseline repo runs real git against the user's real work tree and
 * inherits the user's real git config, so git's leniency and the user's environment are both
 * inputs. A call that "succeeds" can do something other than what the caller assumed.
 *
 * Each test builds its own temp repo. Two of them change git's environment, and a shared
 * fixture would let that leak between tests.
 */

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function freshRepo(): Promise<{ root: string; git: BaselineGit }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-hardening-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = new BaselineGit(path.join(root, '.vscode', 'interactive-review'), root, () => {});
  await git.initGit();
  return { root, git };
}

/** Point git's *global* config at a temp file for the duration of one test. */
function withGlobalGitConfig(contents: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-gitcfg-'));
  const cfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfg, contents);
  const prior = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  cleanups.push(() => {
    if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

describe('BaselineGit: filenames are literal, never patterns', () => {
  // Defect: renameFile/removeFile pass paths to `git ls-files -- <path>`, and git read
  // `[...]`, `*` and `?` as glob syntax. Renaming `x[1].txt` also matched `x1.txt`, so the
  // rename rewrote a *different* file's baseline entry. Fixed by GIT_LITERAL_PATHSPECS=1.
  const cases: [string, string, string][] = [
    ['brackets', 'x[1].txt', 'x1.txt'],
    ['star', 'x*.txt', 'xy.txt'],
    ['question mark', 'x?.txt', 'xa.txt'],
  ];

  for (const [name, patterned, bystander] of cases) {
    it(`renaming a file whose name contains ${name} leaves ${bystander} alone`, async () => {
      const { root, git } = await freshRepo();
      const src = path.join(root, patterned);
      const other = path.join(root, bystander);
      const dest = path.join(root, 'renamed.txt');
      await git.snapshotBatch([
        { filePath: src, content: 'patterned\n' },
        { filePath: other, content: 'bystander\n' },
      ]);

      await git.renameFile(src, dest);

      assert.equal(await git.getBaseline(other), 'bystander\n',
        `${bystander} must keep its own baseline — it was glob-matched by ${patterned}`);
      assert.equal(await git.getBaseline(dest), 'patterned\n');
      assert.equal(await git.getBaseline(src), undefined);
      const tracked = (await git.listTrackedFiles()).map(f => path.basename(f)).sort();
      assert.deepEqual(tracked, [bystander, 'renamed.txt'].sort());
    });
  }
});

describe('BaselineGit.getBaseline: an untracked path is undefined, never text', () => {
  // Defect found by the rename tests above, not by review. getBaseline used `git show
  // :<path>` and relied on it failing for an untracked path. It does fail for plain names,
  // but git accepts any argument containing glob characters as a pathspec, so for an
  // untracked `y[2].txt` show exited 0 — printing the HEAD commit before the literal-
  // pathspec fix, and nothing after it. Callers read the first as a baseline made of
  // commit text and the second as a tracked empty file.
  //
  // `y2.txt` is tracked deliberately: it is what the glob `y[2].txt` matches, which is what
  // made the pre-fix `git show` print a commit rather than nothing.
  const untracked = ['y[2].txt', 'y*.txt', 'y?.txt', 'plain-untracked.txt'];

  for (const name of untracked) {
    it(`returns undefined for untracked ${name}`, async () => {
      const { root, git } = await freshRepo();
      await git.snapshot(path.join(root, 'y2.txt'), 'tracked\n');

      assert.equal(await git.getBaseline(path.join(root, name)), undefined);
    });
  }

  // Found by review of the fix above. `:<path>` is ambiguous in its own way: git reads
  // `:<n>:<rest>` as stage n of <rest>, so these tracked root files were reported as
  // untracked — an edit to one was reviewed against no baseline, and deleting it was
  // ignored. getBaseline now pins stage 0 explicitly.
  for (const name of ['1:notes.txt', '0:a.txt', '3:x']) {
    it(`returns the baseline of a tracked root file named ${name}`, async () => {
      const { root, git } = await freshRepo();
      await git.snapshot(path.join(root, name), 'staged-looking\n');

      assert.equal(await git.getBaseline(path.join(root, name)), 'staged-looking\n');
    });
  }

  it('still returns an empty string — not undefined — for a tracked empty file', async () => {
    // The opposite direction. '' is a legitimate baseline (an empty file that existed at
    // enable), and conflating it with "untracked" would reclassify it as a new file.
    const { root, git } = await freshRepo();
    const file = path.join(root, 'empty.txt');
    await git.snapshot(file, '');

    assert.equal(await git.getBaseline(file), '');
  });

  it('returns a tracked bracketed file\'s own content', async () => {
    const { root, git } = await freshRepo();
    await git.snapshotBatch([
      { filePath: path.join(root, 'z[1].txt'), content: 'bracketed\n' },
      { filePath: path.join(root, 'z1.txt'), content: 'plain\n' },
    ]);

    assert.equal(await git.getBaseline(path.join(root, 'z[1].txt')), 'bracketed\n');
  });
});

describe('BaselineGit: the user\'s global git config cannot break snapshots', () => {
  // Defect: commit() ran plain `git commit`, inheriting the user's global config. Each of
  // these two settings made every snapshot fail. They are separate tests so reverting
  // either half of the fix fails exactly one of them.

  it('commits even when the user has commit.gpgsign=true', async () => {
    // gpg.program=false guarantees signing fails if it is attempted, so this cannot pass
    // by accident on a machine that happens to have a usable signing key.
    withGlobalGitConfig('[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n');
    const { root, git } = await freshRepo();
    const file = path.join(root, 'signed.txt');

    await git.snapshot(file, 'content\n');

    assert.equal(await git.getBaseline(file), 'content\n');
  });

  it('commits even when the user\'s core.hooksPath has a failing pre-commit hook', async () => {
    const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-hooks-'));
    cleanups.push(() => fs.rmSync(hooks, { recursive: true, force: true }));
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    withGlobalGitConfig(`[core]\n\thooksPath = ${hooks}\n`);
    const { root, git } = await freshRepo();
    const file = path.join(root, 'hooked.txt');

    await git.snapshot(file, 'content\n');

    assert.equal(await git.getBaseline(file), 'content\n');
  });
});

describe('BaselineGit: removing a directory path', () => {
  // This used to characterize git's behaviour instead: `update-index --force-remove --
  // <dir>` exits 0 and removes nothing, because the index has no directory entries, and
  // that fact is what made Explorer folder-deletes strand every child's baseline. The
  // characterization was accurate, but pinning it meant `removeFile` was allowed to stay
  // silently wrong for directories — and `renameFile`'s untracked-source fallback then
  // reached it, so a directory renamed onto another directory left the target's baselines
  // behind and the next reload reviewed the moved files as edits of the old ones.
  //
  // `removeFile` now removes the entries `ls-files` reports rather than the pathspec that
  // found them, which is identical for a single file and correct for a directory. The git
  // fact is unchanged; we just no longer rely on it holding. `removePathAndChildren` is
  // still the right entry point from `StateManager` — it also sweeps in-memory state — and
  // is tested in stateManagerGit.test.ts.
  it('removeFile on a directory removes every baseline beneath it', async () => {
    const { root, git } = await freshRepo();
    await git.snapshotBatch([
      { filePath: path.join(root, 'd', 'a.txt'), content: 'a\n' },
      { filePath: path.join(root, 'd', 'b.txt'), content: 'b\n' },
      { filePath: path.join(root, 'keep.txt'), content: 'keep\n' },
    ]);

    await git.removeFile(path.join(root, 'd'));

    assert.deepEqual(await git.listTrackedFiles(), [path.join(root, 'keep.txt')],
      'children of the directory go, everything outside it stays');
  });

  // `ls-files --stage` C-quotes a name holding a `"`, a backslash or a control character
  // even under `core.quotepath=false`, so parsing its lines and handing the result back to
  // `update-index` exits 0 and removes nothing. Verified against a scratch repo. `-z` is
  // what makes the path come back as the real bytes.
  it('removeFile removes a baseline whose name git would C-quote', async () => {
    const { root, git } = await freshRepo();
    const quoted = path.join(root, 'no"te.txt');
    await git.snapshotBatch([
      { filePath: quoted, content: 'q\n' },
      { filePath: path.join(root, 'plain.txt'), content: 'p\n' },
    ]);

    await git.removeFile(quoted);

    assert.deepEqual(await git.listTrackedFiles(), [path.join(root, 'plain.txt')]);
  });

  // Every reader of git's path output in `baselineGit.ts` has now been wrong about C-quoting
  // in turn — `removeFile`, then `renameFile`, then `listTrackedFiles`. These pin the two
  // that are not covered above.
  it('renameFile moves a baseline whose name git would C-quote', async () => {
    const { root, git } = await freshRepo();
    const quoted = path.join(root, 'd', 'no"te.txt');
    await git.snapshotBatch([
      { filePath: quoted, content: 'q\n' },
      { filePath: path.join(root, 'd', 'plain.txt'), content: 'p\n' },
    ]);

    await git.renameFile(path.join(root, 'd'), path.join(root, 'e'));

    // The line-parsed form produced `ed/no\"te.txt"` and left the real file baseline-less,
    // which `handleDiskCreateTree` then adopts as a deletable new file.
    assert.deepEqual(await git.listTrackedFiles(), [
      path.join(root, 'e', 'no"te.txt'),
      path.join(root, 'e', 'plain.txt'),
    ].sort());
    assert.equal(await git.getBaseline(path.join(root, 'e', 'no"te.txt')), 'q\n');
  });

  it('listTrackedFiles reports names git would C-quote, and keeps edge whitespace', async () => {
    const { root, git } = await freshRepo();
    await git.snapshotBatch([
      { filePath: path.join(root, 'no"te.txt'), content: 'q\n' },
      { filePath: path.join(root, 'trail .txt'), content: 't\n' },
    ]);

    assert.deepEqual(await git.listTrackedFiles(), [
      path.join(root, 'no"te.txt'),
      path.join(root, 'trail .txt'),
    ].sort());
  });

  it('removeFile on a single file still removes exactly that file', async () => {
    const { root, git } = await freshRepo();
    await git.snapshotBatch([
      { filePath: path.join(root, 'd', 'a.txt'), content: 'a\n' },
      { filePath: path.join(root, 'd', 'b.txt'), content: 'b\n' },
    ]);

    await git.removeFile(path.join(root, 'd', 'a.txt'));

    assert.deepEqual(await git.listTrackedFiles(), [path.join(root, 'd', 'b.txt')]);
  });
});

describe('BaselineGit: snapshotting a large workspace', () => {
  // Defect: snapshotBatch spawned one `git hash-object` per file with an unbounded
  // Promise.all. A large workspace exhausted file descriptors (EMFILE) all at once, the
  // error was swallowed, and Begin review came up enabled over an EMPTY baseline repo —
  // indistinguishable from "nothing to review".
  //
  // Asserting the concurrency cap directly would only mirror the implementation. What this
  // asserts is the outcome, under the condition that actually broke it: a low fd limit. The
  // workstation's own limit is far too high to reproduce EMFILE, so the snapshot runs in a
  // child process under `ulimit -n`. Against the unbounded code it tracks zero files.
  it('tracks every file under a low file-descriptor limit', () => {
    const FILES = 600;
    const FD_LIMIT = 256;
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-fanout-')), 'run.js');
    cleanups.push(() => fs.rmSync(path.dirname(script), { recursive: true, force: true }));
    fs.writeFileSync(script, `
      const fs = require('fs'), path = require('path'), os = require('os');
      const { BaselineGit } = require(${JSON.stringify(path.join(__dirname, '..', 'baselineGit.js'))});
      (async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-fanout-ws-'));
        try {
          const git = new BaselineGit(path.join(root, '.vscode', 'interactive-review'), root, () => {});
          await git.initGit();
          const files = [];
          for (let i = 0; i < ${FILES}; i++) files.push({ filePath: path.join(root, 'f' + i + '.txt'), content: 'x' + i + '\\n' });
          let threw = null;
          try { await git.snapshotBatch(files); } catch (e) { threw = String(e); }
          const tracked = threw ? -1 : (await git.listTrackedFiles()).length;
          process.stdout.write(JSON.stringify({ threw, tracked }));
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      })();
    `);

    // `$0`/`$1` rather than interpolating paths into the shell string.
    const res = spawnSync('bash', ['-c', `ulimit -n ${FD_LIMIT} && exec "$0" "$1"`, process.execPath, script], {
      encoding: 'utf-8',
      timeout: 60000,
    });
    assert.equal(res.status, 0, `child failed: ${res.stderr}`);
    const out = JSON.parse(res.stdout) as { threw: string | null; tracked: number };

    assert.equal(out.threw, null, `snapshotBatch rejected under ulimit -n ${FD_LIMIT}: ${out.threw}`);
    assert.equal(out.tracked, FILES, 'every file must have a baseline — a partial or empty repo is the defect');
  });
});
