import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PathSerializer } from '../pathSerializer';

/** A task that finishes when told to, so a test controls completion order. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

describe('PathSerializer', () => {
  // The defect this guards: a create and a change handler for one new file ran
  // concurrently, and the one that finished last decided its classification. Here the
  // first task is the slow one — the arrangement where concurrent execution lets the
  // second task finish first and have its write overwritten.
  it('runs tasks for one key in submission order, even when the first is slower', async () => {
    const s = new PathSerializer();
    const order: string[] = [];
    const slow = gate();

    const first = s.run('a.txt', async () => { order.push('create:start'); await slow.promise; order.push('create:end'); });
    const second = s.run('a.txt', async () => { order.push('change:start'); order.push('change:end'); });

    await new Promise(r => setImmediate(r));
    assert.deepEqual(order, ['create:start'], 'the second task must not start while the first runs');
    slow.open();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['create:start', 'create:end', 'change:start', 'change:end']);
  });

  it('runs tasks for different keys concurrently', async () => {
    const s = new PathSerializer();
    const blocker = gate();
    const order: string[] = [];

    const a = s.run('a.txt', async () => { await blocker.promise; order.push('a'); });
    const b = s.run('b.txt', async () => { order.push('b'); });

    await b;
    assert.deepEqual(order, ['b'], 'another path is not held up by a slow one');
    blocker.open();
    await a;
  });

  it('keeps going after a task rejects, and passes each result through', async () => {
    const s = new PathSerializer();
    const failed = s.run('a.txt', async () => { throw new Error('boom'); });
    const next = s.run('a.txt', async () => 42);

    await assert.rejects(failed, /boom/);
    assert.equal(await next, 42);
  });

  it('forgets a key once its queue is empty', async () => {
    const s = new PathSerializer();
    await s.run('a.txt', async () => {});
    await new Promise(r => setImmediate(r));
    assert.equal(s.activeKeys, 0);
  });
});
