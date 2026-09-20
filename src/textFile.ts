import * as fs from 'fs';

/**
 * Binary detection for the baseline path.
 *
 * The reason this exists at all: `fs.readFile(path, 'utf-8')` **does not throw on binary
 * input**. It decodes what it can and substitutes U+FFFD for the rest, so a PNG read this
 * way yields a plausible-looking string. `readBatch` carried a comment asserting the
 * opposite ("binary files ... fail to read"), and every read site relied on it, so
 * binaries were being stored as replacement-character mush in the baseline repo.
 *
 * That is not merely untidy. A baseline is content the extension will *write back*:
 * `discardHunk` restores a file from its baseline lines. A mojibake baseline therefore
 * means a discard can overwrite a real binary with its own lossy decoding — the file is
 * destroyed, and nothing in the flow looks unusual while it happens.
 *
 * The rule this module enforces is narrow and sufficient: **binary content never becomes
 * a baseline.** A *new* binary may still enter review with a `null` baseline (a new
 * `.xlsx` in the queue is useful, and discarding it deletes rather than rewrites — pinned
 * by `filewatch.test.ts`). A *change* to a pre-existing binary with no baseline must not:
 * enable skipped it, so treating the rewrite as "new" would invite Discard → trash on an
 * asset that already existed (`handleDiskChange` guards that path).
 */

/**
 * Drop a leading UTF-8 BOM, if present.
 *
 * The two sides of every comparison in this extension come from sources that disagree
 * about the BOM, and nothing normalized them:
 *
 * - Baselines arrive from `git show :path` (raw blob bytes) or `fs.readFile(…, 'utf-8')`.
 *   Both **keep** the BOM as a leading U+FEFF.
 * - Current text usually arrives from `doc.getText()`. VS Code strips the BOM on open,
 *   remembers it, and rewrites it on save, so the buffer text **never** has one.
 *
 * A BOM'd file therefore diffed as though its first line always differed: a phantom hunk
 * on line 1 that could not be resolved, since accepting it wrote a BOM-less first line
 * into the baseline while the file on disk kept its BOM. The same mismatch made every
 * hand-save of such a file fall through to review, because `consumeManualSave` compares
 * the saved buffer text against the bytes on disk.
 *
 * Only position 0 is examined. A U+FEFF anywhere else is a zero-width no-break space —
 * real content, and not ours to remove.
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Re-attach `source`'s BOM to `text`, if it had one and `text` does not.
 *
 * The other half of the rule in `stripBom`. Baselines are split into lines and spliced to
 * build the *next* baseline, and the replacement lines come from the buffer — which has no
 * BOM. Without this, accepting a hunk that touches line 1 would quietly drop the marker
 * from the stored baseline, and a later `discardFileByPath` restore would then write the
 * file back without it.
 *
 * The division of labour is worth stating once: text headed for a **document** must never
 * carry a BOM (VS Code re-adds its own on save, so a carried one becomes a second BOM in
 * the file), while text headed for **storage or a raw disk write** must keep it.
 */
export function withBomFrom(source: string, text: string): string {
  return source.charCodeAt(0) === 0xfeff && text.charCodeAt(0) !== 0xfeff ? BOM_CHAR + text : text;
}

/**
 * The BOM a file on disk starts with, as a string to prepend — `''` when it has none.
 *
 * `withBomFrom` carries the marker from an existing baseline, which covers every file that
 * has one. A file being reviewed with a `null` baseline has nothing to carry: there is no
 * prior text to inherit from, and `doc.getText()` never has a BOM regardless of what the
 * file holds. Accepting a hunk on a new BOM'd file therefore stored a BOM-less baseline
 * and lost the marker on the next restore — the same bug `withBomFrom` fixes elsewhere,
 * surviving in the one case it cannot see. Disk is the only remaining witness.
 *
 * Three bytes, opened and closed per call. That is affordable on the accept path (one
 * file, one user action) and is why this is not folded into the whole-file reads.
 *
 * An unopenable file reports `''`: the callers are mid-accept on a file they have already
 * read, so a failure here means the file just vanished, and the accept has bigger problems
 * than its encoding marker.
 */
export function bomFromFile(filePath: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(3);
    const bytesRead = fs.readSync(fd, buf, 0, 3, 0);
    return bytesRead === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? BOM_CHAR : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Bytes to sample. A NUL in the first block is the same signal `git` and `grep` use. */
const SNIFF_BYTES = 8192;

/** U+FEFF, spelled out — it is invisible in source otherwise. */
const BOM_CHAR = '\uFEFF';

/**
 * Does this buffer look like binary content?
 *
 * A NUL byte is the test, matching `git`'s own `buffer_is_binary`. It is deliberately not
 * a UTF-8 validity check: invalid UTF-8 is common in legitimately-text files (latin-1
 * source, truncated writes) and rejecting those would quietly drop them from review,
 * which is the failure mode this project cares most about avoiding. A NUL, by contrast,
 * effectively never appears in text a user is editing.
 */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, SNIFF_BYTES).includes(0);
}

/**
 * Read a file as UTF-8 text, or return `null` if it is binary.
 *
 * Reads as a `Buffer` and decodes only after the check — decoding first would already
 * have lost the bytes the check depends on. Read errors propagate: callers distinguish
 * "unreadable" (transient, skip) from "binary" (permanent, never baseline), and
 * collapsing the two here would take that choice away from them.
 */
export async function readTextFile(filePath: string): Promise<string | null> {
  const buf = await fs.promises.readFile(filePath);
  return looksBinary(buf) ? null : buf.toString('utf-8');
}

/** A file read once, with the verdict attached. */
export interface FileRead {
  /** UTF-8 decoding of the bytes. Lossy when `binary` — safe to diff, never to persist. */
  text: string;
  binary: boolean;
}

/**
 * Read for the watcher, which needs both halves of the answer.
 *
 * A binary file still has to *display* — a new `.xlsx` belongs in the queue so it can be
 * accepted or discarded — so the decoded text is returned either way. What the flag gates
 * is persistence: a caller about to snapshot this content as a baseline must not, because
 * the baseline is what a later discard writes back over the file.
 */
export async function readFileForReview(filePath: string): Promise<FileRead> {
  const buf = await fs.promises.readFile(filePath);
  return { text: buf.toString('utf-8'), binary: looksBinary(buf) };
}

/**
 * Synchronous counterpart to `readTextFile`, for the command paths that are already
 * synchronous (`acceptFileByPath`). Same contract: `null` means binary, read errors
 * propagate.
 */
export function readTextFileSync(filePath: string): string | null {
  const buf = fs.readFileSync(filePath);
  return looksBinary(buf) ? null : buf.toString('utf-8');
}

/**
 * Does this path hold binary content, without materializing it?
 *
 * For the callers that only need the verdict and would otherwise decode a whole file to
 * throw the string away. `collectUntrackedFiles` runs this over every file in the
 * workspace, so it reads one block rather than the file: a repo with a few large assets
 * would otherwise pay their full size on every Refresh.
 *
 * A file that cannot be opened is reported as *not* binary. The callers already have
 * their own handling for unreadable files, and answering "binary" here would route them
 * into the wrong one.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return looksBinary(buf.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
