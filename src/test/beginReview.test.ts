import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateManager } from '../stateManager';
import { enableReview } from '../commands';
import type { FileWatcher } from '../fileWatcher';
import type { ReviewPanel } from '../reviewPanel';

declare const global: Record<string, unknown>;

/**
 * `enableReview` — the agent-callable Begin review — against a real StateManager, with the
 * watcher and panel stubbed to the few methods it calls.
 */

let root: string;
let sm: StateManager;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-begin-'));
  global.__reviewTestRoot = root;
  sm = new StateManager();
});

afterEach(async () => {
  await sm.setEnabled(false);
  fs.rmSync(root, { recursive: true, force: true });
});

function stubWatcher(shouldIgnore: (fp: string, isDir?: boolean) => boolean): FileWatcher {
  return {
    beginSnapshot() {},
    endSnapshot() {},
    reloadGitignore() {},
    settleSnapshotCreates: async () => 0,
    shouldIgnore,
  } as unknown as FileWatcher;
}

const panel = { setLoading() {} } as unknown as ReviewPanel;

describe('enableReview', () => {
  // Defect: `setEnabled(true)` flips `enabled` before the snapshot, and nothing reset it
  // when the snapshot threw. The retry an agent makes next hit the "already open" guard and
  // resolved, so the agent started editing over a repo with no baselines.
  it('a failed Begin review can be retried', async () => {
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'v1\n');
    let fail = true;
    const watcher = stubWatcher(() => {
      if (fail) throw new Error('simulated snapshot failure');
      return false;
    });

    await assert.rejects(enableReview(sm, watcher, panel, () => {}), /simulated snapshot failure/);
    assert.equal(sm.enabled, false, 'a failed Begin leaves no session open');

    fail = false;
    await enableReview(sm, watcher, panel, () => {});
    assert.equal(sm.enabled, true);
    assert.equal(await sm.git!.getBaseline(file), 'v1\n', 'the retry recorded the baseline');
  });
});
