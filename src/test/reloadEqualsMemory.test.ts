import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateManager } from '../stateManager';
import { computeHunks } from '../diffEngine';
import { acceptHunkBaseline, discardHunkText } from '../hunkApply';
import { FileState } from '../types';
import { log } from '../log';
import { makeRng, randomLines } from './generators';

declare const global: Record<string, unknown>;

/**
 * "Reload equals memory": after any sequence of operations, a *fresh* StateManager whose
 * `load()` reads only the baseline repo and the disk must reproduce the live one's review
 * queue exactly.
 *
 * The live StateManager holds two copies of the truth — its in-memory map and the baseline
 * repo — and every "phantom after reload" defect was those two disagreeing: a deleted folder
 * whose baselines survived and came back as pending deletions, a second Begin review that
 * rewrote git while memory kept the originals. Each was a separate bug with a separate fix,
 * and each would have failed this one assertion. So rather than an example per bug, drive a
 * random sequence and compare against a reload, at every checkpoint.
 *
 * ## The model
 *
 * The operations call StateManager exactly as `FileWatcher` and `commands.ts` do, with the
 * VS Code plumbing removed. Each helper below names the function it mirrors. That mirror is
 * the cost of testing at this layer — `docs/test-strategy.md` rules out mocking VS Code to
 * reach the real command layer — so keep each one a line-for-line transcription of the
 * decision the real code makes, and update it when that decision changes.
 *
 * Not modelled, and why:
 * - **Accepting with a dirty buffer** (`todo.md` item D). The defect is *which text* the
 *   command passes in — the buffer instead of the disk — so it lives in the command layer,
 *   not here. What this test does establish is the consequence: any baseline folded from
 *   text that is not on disk shows up as a mismatch against a reload.
 * - **Binary files and BOMs.** Covered by `textFile.test.ts` and `hunkApply.test.ts`; they
 *   would add mirror logic here (`withBomFrom`, the binary sniff) without adding reach.
 */

const FILES = ['a.txt', 'b.txt', 'd/c.txt', 'd/e/f.txt', 'g.txt'];
// Kept small so `npm test` stays fast; each step spawns real git. CI runs a deep sweep with
// RELOAD_SEEDS=400 RELOAD_STEPS=25, which is also the command to run after touching
// StateManager, FileWatcher or the commands. Seeds are stable, so a failure reproduces.
const SEEDS = Number(process.env.RELOAD_SEEDS) || 12;
const STEPS = Number(process.env.RELOAD_STEPS) || 14;

let root: string;
let sm: StateManager;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-reload-'));
  global.__reviewTestRoot = root;
  global.__reviewTestNotifications = [];
});

/**
 * Nothing in a healthy sequence should fail a git write. A failure is rolled back, so the
 * queue can still agree with a reload afterwards — which is exactly why it must be checked
 * separately: the rollback is how the End-review defect below hid.
 */
function assertNoErrorsReported(context: string): void {
  const errors = (global.__reviewTestNotifications as { level: string; message: string }[])
    .filter(n => n.level !== 'info');
  assert.deepEqual(errors, [], `unexpected notification ${context}`);
}

afterEach(async () => {
  await sm?.flush();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Mirrors `FileWatcher.shouldIgnore` for the only path it matters for here: our own state. */
const ignore = (fp: string) => fp === path.join(root, '.vscode') || fp.startsWith(path.join(root, '.vscode') + path.sep);

const abs = (rel: string) => path.join(root, rel);

function randomText(rnd: () => number): string {
  const lines = randomLines(rnd, 6);
  const eol = rnd() < 0.2 ? '\r\n' : '\n';
  return lines.length === 0 ? '' : lines.join(eol) + (rnd() < 0.75 ? eol : '');
}

function writeDisk(fp: string, content: string): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

function readDisk(fp: string): string | undefined {
  try { return fs.readFileSync(fp, 'utf-8'); } catch { return undefined; }
}

/** Every regular file under the workspace, excluding our state directory. */
function diskFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (ignore(full)) continue;
      if (e.isDirectory()) walk(full); else if (e.isFile()) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

// ── mirrors of the real event handlers and commands ────────────────────────────────────

/** `FileWatcher.enterReviewing`. */
function enterReviewing(fp: string, baseline: string | null, current: string, nullReason: 'created' | 'unbaselined' = 'unbaselined'): void {
  const isDeleted = !fs.existsSync(fp) && baseline !== null;
  if (computeHunks(baseline, current).length === 0 && baseline !== null && !isDeleted) return;
  sm.setFile(fp, { status: 'reviewing', baseline, ...(baseline === null ? { nullReason } : {}) }, true);
}

/** `FileWatcher.recomputeHunks`. */
function recomputeHunks(fp: string, baseline: string | null, current: string): void {
  if (computeHunks(baseline, current).length === 0 && !(baseline === null && current === '')) {
    sm.exitReviewing(fp);
  }
}

/** `FileWatcher.handleDiskChange`, outside any snapshot or ignore-sync window. */
async function onDiskChange(fp: string, manualSave: boolean): Promise<void> {
  const content = readDisk(fp);
  if (content === undefined) return;
  const st = sm.getFile(fp);
  if (st?.status === 'reviewing') { recomputeHunks(fp, st.baseline, content); return; }
  if (manualSave) { sm.snapshotFile(fp, content); return; }
  const gb = await sm.readBaseline(fp);
  if (gb === undefined) { enterReviewing(fp, null, content, 'unbaselined'); return; }
  enterReviewing(fp, gb, content);
}

/** `FileWatcher.handleDiskCreate`, outside any snapshot window. */
async function onDiskCreate(fp: string): Promise<void> {
  const content = readDisk(fp);
  if (content === undefined) return;
  const st = sm.getFile(fp);
  if (st?.status === 'reviewing') { recomputeHunks(fp, st.baseline, content); return; }
  if (st) return;
  const gb = await sm.readBaseline(fp);
  if (gb !== undefined) { enterReviewing(fp, gb, content); return; }
  enterReviewing(fp, null, content, 'created');
}

/** `FileWatcher.onDiskDelete` for an external (non-Explorer) delete of a single file. */
async function onExternalDelete(fp: string): Promise<void> {
  const st = sm.getFile(fp);
  if (st?.baseline === null) { sm.exitReviewing(fp); return; }
  const gb = st?.baseline ?? await sm.readBaseline(fp);
  if (gb === undefined) { if (st) sm.removeFile(fp); return; }
  enterReviewing(fp, gb, '');
}

/** `acceptFileByPath` (text files only). */
function acceptFile(fp: string): void {
  if (!sm.getFile(fp)) return;
  const content = readDisk(fp);
  if (content === undefined) sm.removeFile(fp);
  else sm.exitReviewing(fp, content);
}

/** `acceptHunk` + `finishBaselineAdvance`, with the buffer equal to disk (no BOM). */
function acceptOneHunk(fp: string, rnd: () => number): void {
  const st = sm.getFile(fp);
  const content = readDisk(fp);
  if (!st || content === undefined) return;
  const baseline = st.baseline ?? '';
  const hunks = computeHunks(st.baseline, content);
  if (hunks.length === 0) return;
  const hunk = hunks[Math.floor(rnd() * hunks.length)];
  const newBaseline = acceptHunkBaseline(baseline, content, hunk);
  if (computeHunks(newBaseline, content).length === 0) sm.exitReviewing(fp, content);
  else sm.setFile(fp, { status: 'reviewing', baseline: newBaseline });
}

/**
 * `discardFileByPath`. The disk writes are the extension's own, so the watcher ignores them
 * (`markSelfEdit`) and no event handler runs.
 */
function discardFile(fp: string): void {
  const st = sm.getFile(fp);
  if (!st) return;
  if (st.baseline === null && st.nullReason === 'created') {
    fs.rmSync(fp, { force: true });
  } else if (st.baseline !== null) {
    writeDisk(fp, st.baseline);
  }
  if (st.baseline === null && st.nullReason === 'created') sm.removeFile(fp);
  else if (st.baseline === null) acceptFile(fp);
  else sm.exitReviewing(fp);
}

/**
 * `discardHunk` + `applyEditAndAdvance`, with the buffer equal to disk (no BOM). The edit is
 * the extension's own, so no event handler runs. An unbaselined file is resolved whole, as
 * `keepsUnbaselinedFile` does.
 */
function discardOneHunk(fp: string, rnd: () => number): void {
  const st = sm.getFile(fp);
  const content = readDisk(fp);
  if (!st || content === undefined) return;
  if (st.baseline === null && st.nullReason !== 'created') { discardFile(fp); return; }
  const hunks = computeHunks(st.baseline, content);
  if (hunks.length === 0) return;
  const hunk = hunks[Math.floor(rnd() * hunks.length)];
  const next = discardHunkText(st.baseline ?? '', content, hunk);
  writeDisk(fp, next);
  if (computeHunks(st.baseline, next).length === 0) {
    if (st.baseline === null) fs.rmSync(fp, { force: true });
    sm.exitReviewing(fp);
  }
}

/** `runBeginReview`, minus the snapshot-window plumbing. */
async function beginReview(): Promise<void> {
  sm = new StateManager();
  await sm.setEnabled(true);
  await sm.snapshotWorkspace(ignore);
}

// ── the property ───────────────────────────────────────────────────────────────────────

/** The review queue as `load()` could possibly know it. */
function queueOf(m: StateManager): Map<string, { status: string; baseline: string | null; created: boolean }> {
  const out = new Map<string, { status: string; baseline: string | null; created: boolean }>();
  for (const [fp, st] of m.getAllFiles() as ReadonlyMap<string, FileState>) {
    out.set(path.relative(root, fp), {
      status: st.status,
      baseline: st.baseline,
      // Absent reads as 'unbaselined' — see FileState.nullReason.
      created: st.baseline === null && st.nullReason === 'created',
    });
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Load a second StateManager from the same repo and disk, and require it to agree with the
 * live one. Returns the fresh manager so a "window reload" step can carry on with it.
 */
async function assertReloadEqualsMemory(context: string): Promise<StateManager> {
  await sm.flush();
  const fresh = new StateManager();
  await fresh.load(ignore);
  await fresh.flush();
  assert.deepEqual(queueOf(fresh), queueOf(sm), `reload disagrees with memory ${context}`);
  assertNoErrorsReported(context);
  return fresh;
}

type Op = { name: string; run: () => Promise<void> };

function pickOp(rnd: () => number): Op {
  const files = diskFiles();
  const anyFile = abs(FILES[Math.floor(rnd() * FILES.length)]);
  const existing = files.length > 0 ? files[Math.floor(rnd() * files.length)] : undefined;
  const queued = [...sm.getAllFiles().keys()];
  const inQueue = queued.length > 0 ? queued[Math.floor(rnd() * queued.length)] : undefined;
  const r = rnd();
  const rel = (fp: string) => path.relative(root, fp);

  if (r < 0.22 && existing) {
    const text = randomText(rnd);
    return { name: `edit ${rel(existing)}`, run: async () => { writeDisk(existing, text); await onDiskChange(existing, false); } };
  }
  if (r < 0.30 && existing) {
    const text = randomText(rnd);
    return { name: `save-in-editor ${rel(existing)}`, run: async () => { writeDisk(existing, text); await onDiskChange(existing, true); } };
  }
  if (r < 0.36 && !fs.existsSync(anyFile)) {
    const text = randomText(rnd);
    return { name: `create ${rel(anyFile)}`, run: async () => { writeDisk(anyFile, text); await onDiskCreate(anyFile); } };
  }
  if (r < 0.40 && !fs.existsSync(anyFile)) {
    // A create the watcher missed, surfacing only as a change: the ADR-0012 path, and the
    // way a text file becomes `nullReason: 'unbaselined'`. Without it the generator never
    // produces that population, and every defect it has had lived there.
    const text = randomText(rnd);
    return { name: `missed-create ${rel(anyFile)}`, run: async () => { writeDisk(anyFile, text); await onDiskChange(anyFile, false); } };
  }
  if (r < 0.48 && existing) {
    return { name: `external-delete ${rel(existing)}`, run: async () => { fs.rmSync(existing); await onExternalDelete(existing); } };
  }
  if (r < 0.53 && existing) {
    // Explorer delete: FileWatcher.onDiskDelete's pendingUserDeletes branch.
    return { name: `explorer-delete ${rel(existing)}`, run: async () => { fs.rmSync(existing); sm.removePathAndChildren(existing); } };
  }
  if (r < 0.57 && fs.existsSync(abs('d'))) {
    // Explorer delete of a whole folder — the directory is gone before the event arrives.
    return { name: 'explorer-delete d/', run: async () => { fs.rmSync(abs('d'), { recursive: true }); sm.removePathAndChildren(abs('d')); } };
  }
  if (r < 0.64 && existing) {
    const target = abs(FILES[Math.floor(rnd() * FILES.length)]);
    // Onto a free path, which includes one whose deletion is still in review: the rename
    // replaces it (see "renaming onto a pending deletion" below).
    if (!fs.existsSync(target)) {
      // Explorer rename: onWillRenameFiles migrates state first, then the disk moves.
      return {
        name: `rename ${rel(existing)} → ${rel(target)}`,
        run: async () => {
          sm.renameFile(existing, target);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(existing, target);
        },
      };
    }
  }
  if (r < 0.74 && inQueue) return { name: `accept-file ${rel(inQueue)}`, run: async () => acceptFile(inQueue) };
  if (r < 0.84 && inQueue) return { name: `accept-hunk ${rel(inQueue)}`, run: async () => acceptOneHunk(inQueue, rnd) };
  if (r < 0.88 && inQueue) return { name: `discard-file ${rel(inQueue)}`, run: async () => discardFile(inQueue) };
  if (r < 0.91 && inQueue) return { name: `discard-hunk ${rel(inQueue)}`, run: async () => discardOneHunk(inQueue, rnd) };
  if (r < 0.93) {
    // A second Begin review on an open session is refused by `enableReview`; this is the
    // End-then-Begin cycle, which must leave an empty queue that a reload agrees with.
    return { name: 'end+begin review', run: async () => { await sm.setEnabled(false); await beginReview(); } };
  }
  if (r < 0.97) {
    // `interactiveReview.refresh`. A Refresh re-derives the queue from git and disk, so it
    // must be a no-op on a correct queue. Asserted here rather than left to the next reload
    // check, because a Refresh that *changed* memory would also make that check pass: it
    // would have overwritten the wrong answer with git's.
    return {
      name: 'refresh',
      run: async () => {
        await sm.flush();
        const before = queueOf(sm);
        await sm.rebuildState(ignore);
        assert.deepEqual(queueOf(sm), before, 'Refresh changed the review queue');
      },
    };
  }
  return { name: 'window reload', run: async () => { sm = await assertReloadEqualsMemory('at a window reload'); } };
}

describe('reload equals memory', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: a fresh load() reproduces the live review queue`, async () => {
      const rnd = makeRng(seed * 7919);
      for (const f of FILES) if (rnd() < 0.8) writeDisk(abs(f), randomText(rnd));
      await beginReview();

      const trail: string[] = [];
      for (let step = 0; step < STEPS; step++) {
        const op = pickOp(rnd);
        trail.push(op.name);
        // Interleaved with StateManager's own lines under INTERACTIVE_REVIEW_LOG_FILE.
        log(`[reload-equals-memory seed ${seed}] step ${step}: ${op.name}`);
        try {
          await op.run();
        } catch (err) {
          if (err instanceof assert.AssertionError) err.message += `\n  after: ${trail.join(' → ')}`;
          throw err;
        }
        if (step % 5 === 4) await assertReloadEqualsMemory(`after: ${trail.join(' → ')}`);
      }
      await assertReloadEqualsMemory(`after: ${trail.join(' → ')}`);
    });
  }
});

/**
 * Named examples: each pins a sequence that once broke, so it survives a generator change
 * (docs/test-strategy.md, rule 3).
 */
describe('reload equals memory — pinned sequences', () => {
  it('an Explorer folder delete leaves no phantom deletions behind', async () => {
    writeDisk(abs('d/c.txt'), 'c\n');
    writeDisk(abs('d/e/f.txt'), 'f\n');
    writeDisk(abs('a.txt'), 'a\n');
    await beginReview();
    // One child edited (in memory) and one never touched (in git only) — the second kind is
    // the one an in-memory sweep cannot find.
    writeDisk(abs('d/c.txt'), 'c changed\n');
    await onDiskChange(abs('d/c.txt'), false);

    fs.rmSync(abs('d'), { recursive: true });
    sm.removePathAndChildren(abs('d'));

    await assertReloadEqualsMemory('after deleting d/');
    assert.equal(sm.getAllFiles().size, 0);
  });

  it('accepting one hunk of several persists the partial baseline', async () => {
    writeDisk(abs('a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    await beginReview();
    writeDisk(abs('a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n');
    await onDiskChange(abs('a.txt'), false);
    assert.equal(computeHunks(sm.getFile(abs('a.txt'))!.baseline, readDisk(abs('a.txt'))!).length, 2);

    acceptOneHunk(abs('a.txt'), () => 0);

    await assertReloadEqualsMemory('after accepting the first of two hunks');
  });

  // Found by this property (seed 4). An accept queues its new baseline; a delete arriving
  // before the queue drained read the *old* one straight from git, so the deletion was
  // shown — and would have been restored by Discard — against text already accepted away.
  it('a delete straight after an accept is reviewed against the accepted text', async () => {
    writeDisk(abs('a.txt'), 'original\n');
    await beginReview();
    writeDisk(abs('a.txt'), 'accepted\n');
    await onDiskChange(abs('a.txt'), false);

    acceptFile(abs('a.txt'));          // queues the new baseline — deliberately not flushed
    fs.rmSync(abs('a.txt'));
    await onExternalDelete(abs('a.txt'));

    assert.equal(sm.getFile(abs('a.txt'))?.baseline, 'accepted\n');
    await assertReloadEqualsMemory('after accept then delete');
  });

  // Found by this property (seeds 14 and 25). The folder delete queues the removal of every
  // baseline under it; a create arriving first found the doomed baseline and queued an edit
  // against it, which a reload — reading the repo after the removal — could not reproduce.
  it('a file recreated straight after an Explorer folder delete is new', async () => {
    writeDisk(abs('d/e/f.txt'), 'old\n');
    await beginReview();

    fs.rmSync(abs('d'), { recursive: true });
    sm.removePathAndChildren(abs('d'));  // queued — deliberately not flushed
    writeDisk(abs('d/e/f.txt'), 'new\n');
    await onDiskCreate(abs('d/e/f.txt'));

    assert.equal(sm.getFile(abs('d/e/f.txt'))?.baseline, null);
    await assertReloadEqualsMemory('after folder delete then recreate');
  });

  // Found by this property (seed 5). End review destroyed the repo with the accept's write
  // still queued; the write failed, its rollback put the file back into the ended session,
  // and the user was told a baseline update had failed "so you can retry".
  it('End review straight after an accept reports nothing and leaves nothing behind', async () => {
    writeDisk(abs('a.txt'), 'original\n');
    await beginReview();
    writeDisk(abs('a.txt'), 'accepted\n');
    await onDiskChange(abs('a.txt'), false);

    acceptFile(abs('a.txt'));          // queues the new baseline — deliberately not flushed
    await sm.setEnabled(false);
    await sm.flush();

    assert.equal(sm.getAllFiles().size, 0, 'an ended session holds no review entries');
    assertNoErrorsReported('after End review');
  });

  // Found by this property (seed 114, once `missed-create` existed). Discard leaves an
  // unbaselined file on disk and dropped only its entry, so nothing a rescan reads said it
  // had been dealt with, and the next Refresh or window reload queued it again.
  it('discarding an unbaselined file keeps it out of the queue after a reload', async () => {
    writeDisk(abs('a.txt'), 'a\n');
    await beginReview();
    writeDisk(abs('g.txt'), 'the watcher missed this create\n');
    await onDiskChange(abs('g.txt'), false);
    assert.equal(sm.getFile(abs('g.txt'))?.nullReason, 'unbaselined');

    discardFile(abs('g.txt'));

    assert.equal(readDisk(abs('g.txt')), 'the watcher missed this create\n', 'Discard keeps an unbaselined file');
    await assertReloadEqualsMemory('after discarding an unbaselined file');
    assert.equal(sm.getAllFiles().size, 0);
  });

  it('a renamed file keeps its pending review across a reload', async () => {
    writeDisk(abs('a.txt'), 'before\n');
    await beginReview();
    writeDisk(abs('a.txt'), 'after\n');
    await onDiskChange(abs('a.txt'), false);

    sm.renameFile(abs('a.txt'), abs('g.txt'));
    fs.renameSync(abs('a.txt'), abs('g.txt'));

    await assertReloadEqualsMemory('after renaming a reviewing file');
    assert.equal(sm.getFile(abs('g.txt'))?.baseline, 'before\n');
  });

  // Defect: renaming an *unedited* file onto a path that still had a pending deletion. git
  // moved the source's baseline over the target's (`BaselineGit.renameFile`), but memory kept
  // the target's deletion entry, so the queue showed a change a reload did not. Decided
  // 2026-09-21: the source wins, so the rename replaces the pending deletion, as a reload
  // already read it. Found by the deep sweep; 30 of 400 seeds reached it.
  it('renaming an unedited file onto a pending deletion', async () => {
    writeDisk(abs('a.txt'), 'deleted soon\n');
    writeDisk(abs('b.txt'), 'moved\n');
    await beginReview();
    fs.rmSync(abs('a.txt'));
    await onExternalDelete(abs('a.txt'));

    sm.renameFile(abs('b.txt'), abs('a.txt'));
    fs.renameSync(abs('b.txt'), abs('a.txt'));

    await assertReloadEqualsMemory('after renaming onto a pending deletion');
    assert.equal(sm.getFile(abs('a.txt')), undefined, 'the moved file is unedited, so nothing is pending');
  });

  // The same decision when the source is a new file, which has no baseline for git to move:
  // the target's old baseline had to be removed, or a reload reviewed the moved file as an
  // edit of the deleted one.
  it('renaming a new file onto a pending deletion', async () => {
    writeDisk(abs('a.txt'), 'deleted soon\n');
    await beginReview();
    fs.rmSync(abs('a.txt'));
    await onExternalDelete(abs('a.txt'));
    writeDisk(abs('b.txt'), 'agent output\n');
    await onDiskCreate(abs('b.txt'));

    sm.renameFile(abs('b.txt'), abs('a.txt'));
    fs.renameSync(abs('b.txt'), abs('a.txt'));

    await assertReloadEqualsMemory('after renaming a new file onto a pending deletion');
    assert.equal(sm.getFile(abs('a.txt'))?.nullReason, 'created', 'still reviewed as the new file it is');
  });
});

/**
 * Properties of `FileWatcher` that cannot be checked behaviourally in a unit test, because
 * it cannot be loaded without VS Code. So check the source. Each one reintroduces a defect
 * pinned elsewhere if it stops holding, whatever this file's mirrors do.
 */
describe('FileWatcher source guards', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'fileWatcher.ts'), 'utf-8');
  const lines = src.split('\n').map(l => l.trim());
  const code = (l: string) => !l.startsWith('//') && !l.startsWith('*');

  it('reads baselines only through StateManager.readBaseline', () => {
    const direct = lines.map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => code(line) && /\.getBaseline\(/.test(line));
    assert.deepEqual(direct, [], 'read through stateManager.readBaseline, which drains queued writes first');
  });

  // A handler that decided against one session and writes after the baseline read would put
  // a file into the queue after End review cleared it — see `StateManager.session`.
  it('re-checks the session straight after every baseline read', () => {
    const unguarded = lines.map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line, n }) => code(line) && line.includes('await this.stateManager.readBaseline(')
        && !lines[n].includes('this.stateManager.session !== session'));
    assert.deepEqual(unguarded, []);
  });

  // Create, change and delete handlers for one path must run in arrival order, or the
  // change handler for a new file can overwrite the create's 'created' — see PathSerializer.
  it('dispatches create, change and delete events through the per-path serializer', () => {
    for (const handler of ['this.handleDiskCreate(', 'this.handleDiskChange(', 'this.onDiskDelete(']) {
      const at = lines.findIndex(l => code(l) && l.includes(handler) && !l.startsWith('private'));
      assert.ok(at >= 0, `${handler} is called`);
      const window = lines.slice(Math.max(0, at - 3), at + 1).join('\n');
      assert.match(window, /this\.perPath\.run\(/, `${handler} runs inside perPath.run`);
    }
  });
});
