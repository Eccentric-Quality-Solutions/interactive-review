import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setTestConfig, ConfigurationTarget, TestConfigStore } from './__mocks__/vscode';
import { applyInlineDiffSettings, restoreDiffSettings } from '../diffSettings';

const LEDGER_KEY = 'interactiveReview.priorDiffEditorSettings';

/**
 * Memento stand-in: the extension's globalState is just a JSON-ish key/value store.
 * `failUpdate` injects a memento-write failure, which is the only way to reach the
 * window between recording a key and writing it.
 */
function memento(seed?: Record<string, unknown>) {
  const map = new Map<string, unknown>(seed ? [[LEDGER_KEY, seed]] : []);
  return {
    failUpdate: false,
    get<T>(key: string, fallback?: T): T | undefined { return (map.has(key) ? map.get(key) : fallback) as T | undefined; },
    async update(key: string, value: unknown): Promise<void> {
      if (this.failUpdate) throw new Error('globalState write failed');
      if (value === undefined) map.delete(key); else map.set(key, JSON.parse(JSON.stringify(value)));
    },
    keys(): readonly string[] { return [...map.keys()]; },
    setKeysForSync(): void { /* unused */ },
  };
}

const DEFAULTS = { 'diffEditor.renderSideBySide': true, 'diffEditor.codeLens': false };
const globalLayer = (s: TestConfigStore) => s.global;

describe('diffSettings', () => {
  let store: TestConfigStore;
  beforeEach(() => { store = __setTestConfig({ global: {}, defaults: { ...DEFAULTS } }); });

  /**
   * The defect this guards: the nudge wrote the user's settings.json and nothing ever
   * put it back, so installing the extension permanently changed two global editor
   * preferences (ADR-0003).
   */
  it('restores an unset setting by removing the key, not by pinning the default', async () => {
    const m = memento();
    await applyInlineDiffSettings(m);
    assert.deepEqual(globalLayer(store), { 'diffEditor.renderSideBySide': false, 'diffEditor.codeLens': true });

    await restoreDiffSettings(m);
    assert.deepEqual(globalLayer(store), {}, 'should leave settings.json as it found it');
    assert.deepEqual(new Set(store.updateTargets), new Set([ConfigurationTarget.Global]),
      'only the global layer may ever be written');
  });

  it('restores an explicit prior value', async () => {
    store.global['diffEditor.renderSideBySide'] = true;   // user deliberately wants side-by-side
    store.global['diffEditor.codeLens'] = false;
    const m = memento();

    await applyInlineDiffSettings(m);
    await restoreDiffSettings(m);

    assert.deepEqual(globalLayer(store), { 'diffEditor.renderSideBySide': true, 'diffEditor.codeLens': false });
  });

  it('never records its own writes when nudged repeatedly', async () => {
    const m = memento();
    await applyInlineDiffSettings(m);
    await applyInlineDiffSettings(m);
    await applyInlineDiffSettings(m);
    await restoreDiffSettings(m);
    assert.deepEqual(globalLayer(store), {});
  });

  it('leaves alone a key that already matched, and restores only what it wrote', async () => {
    store.global['diffEditor.codeLens'] = true;  // already what we want
    const m = memento();

    await applyInlineDiffSettings(m);
    await restoreDiffSettings(m);

    assert.deepEqual(globalLayer(store), { 'diffEditor.codeLens': true },
      'the user\'s own codeLens=true must survive; only renderSideBySide was borrowed');
  });

  /** A mid-session flip is re-forced (the surface needs it) and re-recorded. */
  it('re-forces a mid-session flip and hands back the newer value', async () => {
    const m = memento();
    await applyInlineDiffSettings(m);
    store.global['diffEditor.renderSideBySide'] = true;  // user flips it back
    await applyInlineDiffSettings(m);                    // next diff re-nudges

    assert.equal(store.global['diffEditor.renderSideBySide'], false, 're-forced for the diff');
    await restoreDiffSettings(m);
    assert.equal(store.global['diffEditor.renderSideBySide'], true, 'the newer value comes back');
  });

  /**
   * Regression: guarding on the *effective* value while recording the *global* value
   * diverges the moment a workspace setting shadows the key. The guard could then never
   * be satisfied, so the second nudge recorded our own write as the value to restore —
   * and `endReview` wrote `renderSideBySide: false` into settings.json permanently.
   */
  it('is not poisoned by a workspace setting that shadows the key', async () => {
    store.workspace = { 'diffEditor.renderSideBySide': true };
    const m = memento();

    await applyInlineDiffSettings(m);
    await applyInlineDiffSettings(m);   // second diff opened in the same session
    await restoreDiffSettings(m);

    assert.deepEqual(globalLayer(store), {},
      'must not leave its own value behind as the user\'s global setting');
  });

  it('leaves a deliberate mid-session change alone instead of reverting it', async () => {
    const m = memento();
    await applyInlineDiffSettings(m);
    // User changes their mind in the Settings UI and opens no further review diff, so
    // there is no re-nudge before the session ends.
    store.global['diffEditor.codeLens'] = false;

    await restoreDiffSettings(m);

    assert.equal(store.global['diffEditor.codeLens'], false, 'the newer choice must survive');
    assert.ok(!('diffEditor.renderSideBySide' in store.global), 'untouched keys still restore');
  });

  /**
   * The ledger outlives a session, so a stale entry must never be treated as
   * authoritative. Restore failed in session 1, the user then set both keys explicitly,
   * and session 2 must hand *those* back — not the values from session 1.
   */
  it('does not let a stale ledger destroy settings the user changed between sessions', async () => {
    const m = memento();
    await applyInlineDiffSettings(m);                 // session 1: borrows both, ledger = {null, null}
    store.shouldFailUpdate = () => true;
    await restoreDiffSettings(m);                     // ...and the restore fails, ledger kept
    store.shouldFailUpdate = undefined;
    assert.ok(m.get(LEDGER_KEY), 'ledger kept for retry');

    store.global['diffEditor.renderSideBySide'] = true;   // user sets both explicitly
    store.global['diffEditor.codeLens'] = false;

    await applyInlineDiffSettings(m);                 // session 2
    await restoreDiffSettings(m);

    assert.deepEqual(globalLayer(store),
      { 'diffEditor.renderSideBySide': true, 'diffEditor.codeLens': false },
      'the between-sessions choices must survive');
  });

  /**
   * A ledger written by an older version can name a key this one no longer forces.
   * `DESIRED[key]` is then `undefined` and matches an unset global, so an unguarded
   * restore would *write* that key — which real `update()` rejects for a setting the
   * extension does not contribute, stranding the legitimate keys with it.
   */
  it('ignores ledger keys it no longer forces', async () => {
    const m = memento({ wordWrap: 'on', renderSideBySide: true });

    await restoreDiffSettings(m);

    assert.ok(!('diffEditor.wordWrap' in store.global), 'must not write a key it does not own');
    assert.deepEqual(m.keys(), [], 'stale ledger still cleared');
  });

  /**
   * The nudge must not throw — `openDiffEditor` awaits it, so a rejection would mean the
   * review diff silently never opens — and whatever it *did* manage to write has to stay
   * restorable.
   */
  it('leaves no unrestorable write when a settings write fails mid-nudge', async () => {
    const m = memento();
    store.shouldFailUpdate = (_key, i) => i === 2;   // settings.json goes read-only after key 1

    await applyInlineDiffSettings(m);

    store.shouldFailUpdate = undefined;
    await restoreDiffSettings(m);
    assert.deepEqual(globalLayer(store), {}, 'whatever was written must still be restorable');
  });

  /**
   * The ordering fix: the ledger entry is persisted *before* the settings write, so the
   * only reachable failure state is "recorded but not written" (restore no-ops), never
   * "written but not recorded" (permanent mutation). Injecting the failure on the
   * *memento* write is what pins the ordering — a failure on the config write can't
   * distinguish the two.
   */
  it('writes nothing when the ledger cannot be persisted', async () => {
    const m = memento();
    m.failUpdate = true;

    await applyInlineDiffSettings(m);

    assert.deepEqual(globalLayer(store), {}, 'no unrecorded write may reach settings.json');
  });

  it('keeps the ledger for retry when restore fails, and the retry is not a double-restore', async () => {
    const m = memento();
    store.global['diffEditor.codeLens'] = false;   // an explicit prior value to hand back
    await applyInlineDiffSettings(m);

    store.shouldFailUpdate = (_key, i) => i === 4;   // second key of the restore pass fails
    await restoreDiffSettings(m);
    assert.ok(m.get(LEDGER_KEY), 'ledger survives a failed restore');

    store.shouldFailUpdate = undefined;
    await restoreDiffSettings(m);
    assert.deepEqual(globalLayer(store), { 'diffEditor.codeLens': false }, 'retry completes the job');
    assert.deepEqual(m.keys(), [], 'ledger cleared once restore succeeds');
  });

  it('is a no-op when it never wrote anything', async () => {
    store.global['diffEditor.renderSideBySide'] = false;
    store.global['diffEditor.codeLens'] = true;
    const m = memento();

    await applyInlineDiffSettings(m);
    assert.deepEqual(m.keys(), [], 'no ledger written');
    await restoreDiffSettings(m);
    assert.deepEqual(globalLayer(store), { 'diffEditor.renderSideBySide': false, 'diffEditor.codeLens': true });
  });
});
