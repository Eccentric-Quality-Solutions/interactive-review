import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import assert from 'assert';
import {
  getWorkspaceRoot, sleep, writeFileExternally, cleanWorkspace,
  getStateManager, enableReview, disableReview, waitForCondition, gitGetBaseline,
} from './helpers';

/**
 * DIAGNOSTIC probe for design.md §4c.1, which records this empirical finding:
 *
 *   "VS Code's createFileSystemWatcher does NOT reliably deliver external raw-fs
 *    create/delete events in the headless Linux test host (events dropped/badly
 *    delayed)."
 *
 * That finding is why `waitForConditionNudged` exists and why no production polling
 * fallback was built. It was measured on a box whose `fs.inotify.max_user_instances`
 * was later found to be at the stock 128 with a desktop session already consuming most
 * of it — so the finding may have been measuring resource starvation rather than a
 * platform limitation. This probe re-measures it directly, and is designed to be run
 * twice: once at stock inotify limits, once raised.
 *
 * Not a regression test — it asserts almost nothing and reports numbers. Skipped unless
 * WATCHER_PROBE=1 so it never runs in the normal suite.
 *
 * Two independent questions, deliberately separated:
 *   A. Does the PLATFORM deliver? Own watcher, own event counters, no extension involved.
 *   B. Does the PRODUCT surface a new file without the nudge? Extension state, no refresh.
 */

const PROBE = process.env.WATCHER_PROBE === '1';
const ROUNDS = Number(process.env.WATCHER_PROBE_ROUNDS ?? 10);
const EVENT_TIMEOUT_MS = 8000;

interface Outcome { delivered: boolean; ms: number }

function summarize(label: string, outcomes: Outcome[]): string {
  const hits = outcomes.filter(o => o.delivered);
  const lat = hits.map(o => o.ms).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : NaN);
  return `${label.padEnd(22)} delivered ${String(hits.length).padStart(3)}/${outcomes.length}` +
    (lat.length
      ? `  min ${pct(0)}ms  p50 ${pct(0.5)}ms  p90 ${pct(0.9)}ms  max ${lat[lat.length - 1]}ms`
      : '  (no deliveries)');
}

/** Resolve when `arm` sees its event, or after EVENT_TIMEOUT_MS. Returns latency. */
function race(arm: (fire: () => void) => vscode.Disposable, act: () => void): Promise<Outcome> {
  return new Promise<Outcome>(resolve => {
    const start = Date.now();
    let done = false;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      sub.dispose();
      clearTimeout(timer);
      resolve({ delivered, ms: Date.now() - start });
    };
    const sub = arm(() => finish(true));
    const timer = setTimeout(() => finish(false), EVENT_TIMEOUT_MS);
    act();
  });
}

suite('watcher probe (diagnostic, WATCHER_PROBE=1)', function () {
  this.timeout(20 * 60 * 1000);

  suiteSetup(function () {
    if (!PROBE) this.skip();
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('A. raw createFileSystemWatcher delivery for external create/change/delete', async () => {
    const root = getWorkspaceRoot();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    const creates: Outcome[] = [];
    const changes: Outcome[] = [];
    const deletes: Outcome[] = [];

    try {
      for (let i = 0; i < ROUNDS; i++) {
        const fp = path.join(root, `probe-${i}.txt`);
        const match = (uri: vscode.Uri) => uri.fsPath === fp;

        creates.push(await race(
          fire => watcher.onDidCreate(u => { if (match(u)) fire(); }),
          () => writeFileExternally(fp, 'created\n'),
        ));

        // Settle so a coalesced create+change isn't scored as a change delivery.
        await sleep(400);

        changes.push(await race(
          fire => watcher.onDidChange(u => { if (match(u)) fire(); }),
          () => writeFileExternally(fp, 'created\nmodified\n'),
        ));

        await sleep(400);

        deletes.push(await race(
          fire => watcher.onDidDelete(u => { if (match(u)) fire(); }),
          () => fs.rmSync(fp, { force: true }),
        ));

        await sleep(400);
      }
    } finally {
      watcher.dispose();
    }

    console.log('\n=== PROBE A: raw vscode.workspace.createFileSystemWatcher ===');
    console.log(`inotify max_user_instances = ${readSysctl('max_user_instances')}, ` +
      `max_queued_events = ${readSysctl('max_queued_events')}`);
    console.log(summarize('onDidCreate', creates));
    console.log(summarize('onDidChange', changes));
    console.log(summarize('onDidDelete', deletes));
    console.log('=============================================================\n');

    assert.strictEqual(creates.length, ROUNDS, 'probe should complete all rounds');
  });

  test('B. brand-new external file surfaces WITHOUT the refresh nudge', async () => {
    const root = getWorkspaceRoot();
    writeFileExternally(path.join(root, 'anchor.txt'), 'anchor\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'anchor.txt') !== undefined);

    const sm = getStateManager();
    const outcomes: Outcome[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      const fp = path.join(root, `nudgeless-${i}.txt`);
      const start = Date.now();
      writeFileExternally(fp, `new file ${i}\n`);

      let delivered = false;
      while (Date.now() - start < EVENT_TIMEOUT_MS) {
        if (sm.getFile(fp)?.status === 'reviewing') { delivered = true; break; }
        await sleep(100); // NO interactiveReview.refresh — that is the whole point
      }
      outcomes.push({ delivered, ms: Date.now() - start });
      await sleep(300);
    }

    console.log('\n=== PROBE B: new file → reviewing, no nudge (end-to-end) ===');
    console.log(summarize('enterReviewing', outcomes));
    console.log('============================================================\n');

    assert.strictEqual(outcomes.length, ROUNDS, 'probe should complete all rounds');
  });
});

function readSysctl(name: string): string {
  try {
    return fs.readFileSync(`/proc/sys/fs/inotify/${name}`, 'utf-8').trim();
  } catch {
    return 'unknown';
  }
}
