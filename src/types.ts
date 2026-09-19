export type FileStatus = 'idle' | 'reviewing';

export interface FileState {
  status: FileStatus;
  /** null = no baseline (see `nullReason`); '' = file existed but was empty; string = file content */
  baseline: string | null;
  /**
   * Why `baseline` is null, and the **sole authority** for whether discarding this file
   * deletes it from disk. Meaningless when `baseline` is a string.
   *
   *   'created'     — the file was observed being created during this session, so it did
   *                   not exist before review began. Discard deletes it (to trash).
   *   'unbaselined' — the file predates the session; we simply never obtained a baseline
   *                   for it (binary, unreadable at enable, or created inside the enable
   *                   snapshot's sliver). Discard must NOT delete it — there is nothing
   *                   to roll back to and the content is the user's, not an agent's.
   *
   * Absent is read as 'unbaselined'. That is the safe direction on purpose: a writer that
   * forgets to set it declines to delete rather than destroying a pre-existing file. The
   * cost of being wrong that way is a file that stays on disk; the cost of the other way
   * is a file that is gone.
   */
  nullReason?: 'created' | 'unbaselined';
}
