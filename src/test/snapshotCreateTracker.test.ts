import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotCreateTracker } from '../snapshotCreateTracker';

/** A promise plus its resolver, so a test can hold a "handler" open deliberately. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let the microtask queue drain so `.then` cleanups have run. */
const tick = () => new Promise<void>(r => setImmediate(r));

describe('SnapshotCreateTracker', () => {
  it('ignores handlers dispatched outside the window', async () => {
    const t = new SnapshotCreateTracker();
    const d = deferred();
    t.track(d.promise);
    assert.equal(t.pending, 0, 'nothing to wait for when the window is closed');
    assert.equal(await t.settle(), 0);
    d.resolve();
  });

  it('waits for a handler that began inside the window', async () => {
    const t = new SnapshotCreateTracker();
    t.open();
    const d = deferred();
    t.track(d.promise);
    assert.equal(t.pending, 1);

    // The property under test: settle must not resolve while the handler is still in its
    // prelude, because that is exactly when it has not yet reached the git queue.
    let settled = false;
    const settling = t.settle().then(n => { settled = true; return n; });
    await tick();
    assert.equal(settled, false, 'settle must block on an unfinished handler');

    d.resolve();
    assert.equal(await settling, 1, 'reports how many it waited on');
  });

  it('reports zero once everything has drained, which is the caller stop signal', async () => {
    const t = new SnapshotCreateTracker();
    t.open();
    const d = deferred();
    t.track(d.promise);
    d.resolve();
    assert.equal(await t.settle(), 1);
    // Second pass finds nothing — proving no handler could have enqueued since.
    assert.equal(await t.settle(), 0);
    assert.equal(t.pending, 0);
  });

  it('a rejecting handler neither throws nor wedges settle', async () => {
    // A create handler that blows up must not fail beginReview, and must not leave an
    // unhandled rejection behind.
    const t = new SnapshotCreateTracker();
    t.open();
    const d = deferred();
    t.track(d.promise);
    d.reject(new Error('handler exploded'));
    assert.equal(await t.settle(), 1);
    assert.equal(t.pending, 0);
  });

  it('waits for handlers that arrive while an earlier settle is in flight', async () => {
    // The reason the caller loops: awaiting is itself a window in which new creates land.
    const t = new SnapshotCreateTracker();
    t.open();
    const first = deferred();
    t.track(first.promise);
    const settling = t.settle();

    const second = deferred();
    t.track(second.promise);
    first.resolve();
    assert.equal(await settling, 1, 'first pass only accounts for what it started with');

    // ...so a second pass is required, and it sees the latecomer.
    let done = false;
    const again = t.settle().then(n => { done = true; return n; });
    await tick();
    assert.equal(done, false);
    second.resolve();
    assert.equal(await again, 1);
    assert.equal(await t.settle(), 0, 'and only then does a pass come back empty');
  });

  it('close drops stragglers and reopening starts clean', async () => {
    const t = new SnapshotCreateTracker();
    t.open();
    const d = deferred();
    t.track(d.promise);
    assert.equal(t.pending, 1);

    t.close();
    assert.equal(t.active, false);
    assert.equal(t.pending, 0, 'an abandoned snapshot must not leave references behind');
    assert.equal(await t.settle(), 0, 'settle after close cannot block');
    d.resolve();

    t.open();
    assert.equal(t.active, true);
    assert.equal(t.pending, 0);
  });

  it('tracks each concurrent handler separately', async () => {
    const t = new SnapshotCreateTracker();
    t.open();
    const ds = [deferred(), deferred(), deferred()];
    ds.forEach(d => t.track(d.promise));
    assert.equal(t.pending, 3);

    let settled = false;
    const settling = t.settle().then(n => { settled = true; return n; });
    ds[0].resolve();
    ds[1].resolve();
    await tick();
    assert.equal(settled, false, 'one outstanding handler is enough to keep waiting');
    ds[2].resolve();
    assert.equal(await settling, 3);
  });
});
