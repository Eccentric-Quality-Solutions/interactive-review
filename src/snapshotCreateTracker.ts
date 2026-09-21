/**
 * Tracks the file-create handlers that begin while the enable-window snapshot is running,
 * so `beginReview` can wait for them before declaring the baseline durable.
 *
 * Extracted from `FileWatcher` rather than left inline because the property it guarantees
 * is a pure scheduling one — "no handler that started inside the window is still running"
 * — and proving that against the real watcher costs a multi-minute integration test whose
 * window depends on how long a workspace snapshot happens to take. Here it is a handful of
 * promises and no `vscode` import.
 */
export class SnapshotCreateTracker {
  private inFlight: Set<Promise<void>> = new Set();
  private _active: boolean = false;

  /** Is the enable window currently open? */
  get active(): boolean { return this._active; }

  /** How many tracked handlers have not finished. Test/diagnostic accessor. */
  get pending(): number { return this.inFlight.size; }

  open(): void { this._active = true; }

  /**
   * Close the window and forget any stragglers. Dropping them is deliberate: `settle` has
   * already run by this point on the success path, and on the throw path the caller is
   * abandoning the snapshot anyway — holding references would only leak.
   */
  close(): void {
    this._active = false;
    this.inFlight.clear();
  }

  /**
   * Register a handler if the window is open, ignoring it otherwise.
   *
   * The window flag is read here, synchronously at dispatch, because arrival time is the
   * property being tested — exactly the reasoning behind `handleDiskCreate` sampling it at
   * entry. Any later read races the window closing.
   *
   * The promise is neutralised with `then(noop, noop)` before being stored. A create
   * handler that rejects must not fail `beginReview` when `settle` awaits it, and an
   * unobserved rejection would otherwise surface as an unhandled rejection in the host.
   */
  track(run: Promise<unknown>): void {
    if (!this._active) return;
    const settled = run.then(() => {}, () => {});
    this.inFlight.add(settled);
    void settled.then(() => { this.inFlight.delete(settled); });
  }

  /**
   * Wait for every currently-tracked handler and report how many there were.
   *
   * The count is the point: awaiting gives newly arrived creates time to start, so a single
   * pass cannot prove quiescence. A pass that waited on *nothing* proves no handler could
   * have reached the git queue since, which is what lets the caller stop draining.
   */
  async settle(): Promise<number> {
    const waited = this.inFlight.size;
    if (waited === 0) return 0;
    await Promise.all(Array.from(this.inFlight));
    return waited;
  }
}
