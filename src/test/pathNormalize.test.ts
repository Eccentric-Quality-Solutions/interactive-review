import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath } from '../pathNormalize';

/**
 * `normalizePath` is a platform conditional, and the conditional is the contract: NFC on
 * macOS, identity everywhere else. Getting it wrong is silent in both directions — on macOS
 * a git path and an `fs.readdir` path miss each other in the same Map, and on Linux two
 * genuinely different filenames collapse onto one key.
 */

// が, composed (U+304C) and decomposed (U+304B U+3099). Same glyph, different bytes.
const NFC = 'が';
const NFD = 'が';
const darwin = process.platform === 'darwin';

describe('normalizePath', () => {
  it('leaves an already-NFC path alone on every platform', () => {
    assert.equal(normalizePath(`/w/${NFC}.txt`), `/w/${NFC}.txt`);
  });

  it('leaves ASCII alone on every platform', () => {
    assert.equal(normalizePath('/w/plain name.txt'), '/w/plain name.txt');
  });

  it('preserves the empty path', () => {
    assert.equal(normalizePath(''), '');
  });

  it(darwin
    ? 'folds NFD to NFC on macOS, where the filesystem is normalization-insensitive'
    : 'is a no-op off macOS, where NFC and NFD can be distinct filenames', () => {
    assert.equal(normalizePath(`/w/${NFD}.txt`), darwin ? `/w/${NFC}.txt` : `/w/${NFD}.txt`);
  });

  it(darwin
    ? 'maps the two forms onto one Map key on macOS'
    : 'keeps the two forms as distinct Map keys off macOS', () => {
    const keys = new Set([normalizePath(`/w/${NFC}.txt`), normalizePath(`/w/${NFD}.txt`)]);
    assert.equal(keys.size, darwin ? 1 : 2);
  });

  it('is idempotent', () => {
    for (const p of [`/w/${NFC}.txt`, `/w/${NFD}.txt`, '/w/plain.txt']) {
      assert.equal(normalizePath(normalizePath(p)), normalizePath(p));
    }
  });
});
