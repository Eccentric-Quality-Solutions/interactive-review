import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiskEvent, DiskEventFacts } from '../diskEvent';

const base: DiskEventFacts = {
  kind: 'create', baseline: undefined, manualSave: false,
  duringSnapshot: false, ignoreSyncActive: false, binary: false,
};

/** Every combination of the inputs: 2 kinds × 2 baselines × 2⁴ flags. */
function allFacts(): DiskEventFacts[] {
  const out: DiskEventFacts[] = [];
  for (const kind of ['create', 'change'] as const) {
    for (const baseline of [undefined, 'text\n']) {
      for (let bits = 0; bits < 16; bits++) {
        out.push({
          kind, baseline,
          manualSave: !!(bits & 1), duringSnapshot: !!(bits & 2),
          ignoreSyncActive: !!(bits & 4), binary: !!(bits & 8),
        });
      }
    }
  }
  return out;
}

describe('classifyDiskEvent', () => {
  describe('invariants, over every input', () => {
    // Discard deletes a 'created' file. Only a witnessed create is evidence the file is new.
    it("only a create is ever classified 'created'", () => {
      for (const f of allFacts()) {
        const d = classifyDiskEvent(f);
        if (d.action === 'review' && d.nullReason === 'created') assert.equal(f.kind, 'create', JSON.stringify(f));
      }
    });

    it('never adopts a binary as a baseline', () => {
      for (const f of allFacts()) {
        if (f.binary) assert.notEqual(classifyDiskEvent(f).action, 'adopt', JSON.stringify(f));
      }
    });

    it('sets nullReason exactly when the reviewed baseline is null', () => {
      for (const f of allFacts()) {
        const d = classifyDiskEvent(f);
        if (d.action === 'review') assert.equal(d.baseline === null, d.nullReason !== undefined, JSON.stringify(f));
      }
    });

    it('reviews against the baseline repo whenever it has one, save aside', () => {
      for (const f of allFacts()) {
        if (f.baseline === undefined || (f.kind === 'change' && f.manualSave)) continue;
        assert.deepEqual(classifyDiskEvent(f), { action: 'review', baseline: f.baseline }, JSON.stringify(f));
      }
    });
  });

  describe('create', () => {
    it("an external create is reviewed as 'created'", () => {
      assert.deepEqual(classifyDiskEvent(base), { action: 'review', baseline: null, nullReason: 'created' });
    });

    it('a create VS Code saved is adopted', () => {
      assert.equal(classifyDiskEvent({ ...base, manualSave: true }).action, 'adopt');
    });

    it('a create during the enable snapshot is adopted, not reviewed as new', () => {
      assert.equal(classifyDiskEvent({ ...base, duringSnapshot: true }).action, 'adopt');
    });

    it('a create of a baselined path is reviewed as a change, even if VS Code saved it', () => {
      assert.deepEqual(classifyDiskEvent({ ...base, baseline: 'old\n', manualSave: true }),
        { action: 'review', baseline: 'old\n' });
    });

    it('ignores the ignore-sync window', () => {
      assert.deepEqual(classifyDiskEvent({ ...base, ignoreSyncActive: true }),
        { action: 'review', baseline: null, nullReason: 'created' });
    });
  });

  describe('change', () => {
    const change: DiskEventFacts = { ...base, kind: 'change' };

    it("a change with no baseline is reviewed as 'unbaselined'", () => {
      assert.deepEqual(classifyDiskEvent(change), { action: 'review', baseline: null, nullReason: 'unbaselined' });
    });

    it('a change VS Code saved is adopted, whatever the baseline repo holds', () => {
      assert.equal(classifyDiskEvent({ ...change, manualSave: true, baseline: 'old\n' }).action, 'adopt');
    });

    it('a change with no baseline is adopted during the snapshot or an ignore sync', () => {
      assert.equal(classifyDiskEvent({ ...change, duringSnapshot: true }).action, 'adopt');
      assert.equal(classifyDiskEvent({ ...change, ignoreSyncActive: true }).action, 'adopt');
    });

    it('a binary with no baseline is skipped, not reviewed', () => {
      assert.equal(classifyDiskEvent({ ...change, binary: true }).action, 'skip');
    });
  });
});
