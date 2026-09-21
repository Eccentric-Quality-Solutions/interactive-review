/**
 * Runs async tasks one at a time per key, in the order they were submitted. Tasks for
 * different keys run concurrently.
 *
 * `FileWatcher` runs every disk-event handler through this, keyed by path. Each handler
 * reads state, awaits a disk read and a baseline read, then writes state from what it read
 * first. Run concurrently, two handlers for one file each decide against a state the other
 * is about to replace, and whichever finishes *last* wins. The case that mattered: writing
 * a new file fires a create and then a change. The change handler, finding no entry yet,
 * classified the file `'unbaselined'`, and when it finished second it overwrote the create
 * handler's `'created'`, so Discard left the agent's file on disk. In arrival order, the
 * change handler finds the entry the create made and only recomputes its hunks.
 *
 * Kept free of `vscode` so the ordering is unit-tested (`pathSerializer.test.ts`) rather
 * than left to an integration test whose outcome depends on event timing.
 */
export class PathSerializer {
  private tails: Map<string, Promise<void>> = new Map();

  /**
   * Run `task` after every task already submitted for `key`. The returned promise settles
   * with `task`'s own result. A task that rejects does not stop the ones queued after it.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const result = prior.then(task);
    const tail = result.then(() => {}, () => {});
    this.tails.set(key, tail);
    // Drop the key once nothing is queued behind this task, so the map does not grow with
    // every path the workspace has ever touched.
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }

  /** How many keys have tasks queued or running. Test/diagnostic accessor. */
  get activeKeys(): number { return this.tails.size; }
}
