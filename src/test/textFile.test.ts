import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bomFromFile, looksBinary, readTextFile, readFileForReview, stripBom, withBomFrom } from '../textFile';

/** UTF-8 byte-order mark, spelled out — it is invisible in source otherwise. */
const BOM = '\uFEFF';

/** Write a fixture and hand back its path; the caller removes it. */
function fixture(name: string, bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-textfile-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('looksBinary', () => {
  it('accepts ordinary text', () => {
    assert.equal(looksBinary(Buffer.from('const x = 1;\nexport { x };\n', 'utf-8')), false);
  });

  it('accepts an empty file', () => {
    assert.equal(looksBinary(Buffer.alloc(0)), false, 'an empty file is a legitimate text file');
  });

  it('accepts non-ASCII UTF-8', () => {
    assert.equal(looksBinary(Buffer.from('café — naïve — 日本語\n', 'utf-8')), false);
  });

  it('accepts invalid UTF-8 that carries no NUL', () => {
    // Lone latin-1 bytes. Deliberately *not* binary: rejecting these would drop
    // legitimately-editable files out of review, the failure this project most avoids.
    assert.equal(looksBinary(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])), false);
  });

  it('rejects content with a NUL byte', () => {
    assert.equal(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), true);
  });

  it('rejects a PNG header', () => {
    assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), true);
  });

  it('only sniffs the first block', () => {
    // A NUL past the sniff window is not detected. Pinned as a known bound rather than
    // asserted as desirable: the alternative is scanning entire files on every read.
    const buf = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0x00])]);
    assert.equal(looksBinary(buf), false);
  });
});

describe('stripBom', () => {
  it('removes a leading BOM', () => {
    assert.equal(stripBom(`${BOM}hello`), 'hello');
  });

  it('leaves BOM-less text untouched', () => {
    assert.equal(stripBom('hello'), 'hello');
  });

  it('leaves an empty string untouched', () => {
    assert.equal(stripBom(''), '');
  });

  it('removes only one BOM', () => {
    // Two markers means the second is content; only position 0 is an encoding marker.
    assert.equal(stripBom(`${BOM}${BOM}x`), `${BOM}x`);
  });

  it('leaves a U+FEFF that is not first', () => {
    assert.equal(stripBom(`a${BOM}b`), `a${BOM}b`);
  });

  it('does not disturb other leading whitespace', () => {
    assert.equal(stripBom('  indented'), '  indented');
  });
});

describe('bomFromFile', () => {
  it('reports the BOM of a file that has one', () => {
    const p = fixture('bom.txt', Buffer.from(`${BOM}hello\n`, 'utf-8'));
    assert.equal(bomFromFile(p), BOM);
  });

  it('reports none for ordinary text', () => {
    const p = fixture('plain.txt', Buffer.from('hello\n', 'utf-8'));
    assert.equal(bomFromFile(p), '');
  });

  it('reports none for a file shorter than a BOM', () => {
    // A 1-2 byte file cannot carry one, and the read must not treat the short
    // count as a match against an uninitialized buffer.
    assert.equal(bomFromFile(fixture('tiny.txt', Buffer.from('a', 'utf-8'))), '');
    assert.equal(bomFromFile(fixture('empty.txt', Buffer.alloc(0))), '');
  });

  it('reports none for a file that cannot be opened', () => {
    assert.equal(bomFromFile(path.join(os.tmpdir(), 'ir-does-not-exist-xyz.txt')), '');
  });

  it('is not fooled by the BOM bytes appearing later', () => {
    const p = fixture('late.txt', Buffer.from(`a${BOM}b`, 'utf-8'));
    assert.equal(bomFromFile(p), '');
  });
});

describe('withBomFrom', () => {
  it('re-attaches a BOM the source had', () => {
    assert.equal(withBomFrom(`${BOM}old`, 'new'), `${BOM}new`);
  });

  it('adds nothing when the source had none', () => {
    assert.equal(withBomFrom('old', 'new'), 'new');
  });

  it('does not double a BOM the text already carries', () => {
    assert.equal(withBomFrom(`${BOM}old`, `${BOM}new`), `${BOM}new`);
  });

  it('round-trips with stripBom', () => {
    const original = `${BOM}a\nb\n`;
    assert.equal(withBomFrom(original, stripBom(original)), original);
  });

  it('handles empty strings on either side', () => {
    assert.equal(withBomFrom('', 'new'), 'new');
    assert.equal(withBomFrom(`${BOM}old`, ''), BOM);
  });
});

describe('readTextFile', () => {
  it('returns the decoded text for a text file', async () => {
    const p = fixture('a.txt', Buffer.from('hello\n', 'utf-8'));
    try {
      assert.equal(await readTextFile(p), 'hello\n');
    } finally { fs.rmSync(path.dirname(p), { recursive: true, force: true }); }
  });

  it('returns null for a binary file rather than mojibake', async () => {
    // The regression this module exists for: readFile(path, 'utf-8') does NOT throw here,
    // it returns replacement characters, and that string used to be stored as a baseline.
    const p = fixture('a.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    try {
      assert.equal(await readTextFile(p), null);
      assert.notEqual(fs.readFileSync(p, 'utf-8'), '', 'utf-8 read really does succeed — hence the explicit check');
    } finally { fs.rmSync(path.dirname(p), { recursive: true, force: true }); }
  });

  it('propagates a read error instead of reporting binary', async () => {
    const missing = path.join(os.tmpdir(), 'ir-textfile-does-not-exist', 'nope.txt');
    await assert.rejects(() => readTextFile(missing), /ENOENT/);
  });
});

describe('readFileForReview', () => {
  it('flags binary but still returns decodable text for display', async () => {
    const p = fixture('a.bin', Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    try {
      const r = await readFileForReview(p);
      assert.equal(r.binary, true);
      assert.equal(typeof r.text, 'string', 'a binary new file still has to render in the queue');
    } finally { fs.rmSync(path.dirname(p), { recursive: true, force: true }); }
  });

  it('reports text files as not binary', async () => {
    const p = fixture('a.txt', Buffer.from('x\n', 'utf-8'));
    try {
      const r = await readFileForReview(p);
      assert.deepEqual(r, { text: 'x\n', binary: false });
    } finally { fs.rmSync(path.dirname(p), { recursive: true, force: true }); }
  });
});
