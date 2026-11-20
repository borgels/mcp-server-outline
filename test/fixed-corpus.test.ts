// Key admission (src/key-admission.ts): the corpus of our own texts is up to date, and a key that is short or shares
// a piece with any of our texts is refused with a text that holds no piece of it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXED_CORPUS } from '../src/fixed-corpus.generated.js';
import { admitsKey, KEY_REFUSED, keyRefusedText, MIN_KEY_LENGTH } from '../src/key-admission.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

describe('credential admission', () => {
  it('has a corpus that lists every string literal in src/', () => {
    // Exits 1, and so throws, when a text was added or changed without regenerating the corpus.
    execFileSync(process.execPath, ['scripts/fixed-corpus.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
    expect(FIXED_CORPUS.length).toBeGreaterThan(20);
  });

  it('accepts a vendor-like key and refuses short keys and keys that share text with our own texts', () => {
    expect(admitsKey('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU')).toBe(true);
    expect(admitsKey('Zq7pX2vK9mWb4Tn'.slice(0, MIN_KEY_LENGTH - 1))).toBe(false);
    const colliding = [
      '‹redacted›-Zq7pX2vK9mWb',
      '[nested too deep]Zq7pX2vK',
      KEY_REFUSED,
      ...FIXED_CORPUS.filter(text => text.length >= 6).slice(0, 50).map(text => `Zq7pX2vK9mWb${text}`),
    ];
    for (const key of colliding) expect(admitsKey(key), key).toBe(false);
  });

  it('accepts real Outline keys: no text of ours shares a piece with the vendor prefix and what follows it', () => {
    // An Outline key is the vendor prefix and 38 letters and digits. Every 6-character piece of a key that overlaps the
    // prefix must be absent from our texts, whatever the random part is; otherwise valid keys would be refused.
    const prefix = ['o', 'l', '_', 'a', 'p', 'i', '_'].join('');
    const overlapping = new RegExp(
      `${prefix.slice(0, 6)}|${prefix.slice(1, 7)}|${prefix.slice(2)}[A-Za-z0-9]|${prefix.slice(3)}[A-Za-z0-9]{2}|${prefix.slice(4)}[A-Za-z0-9]{3}|${prefix.slice(5)}[A-Za-z0-9]{4}`,
    );
    for (const text of [...FIXED_CORPUS, KEY_REFUSED]) expect(overlapping.test(text), text).toBe(false);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let seed = 7;
    for (let round = 0; round < 200; round += 1) {
      let key = prefix;
      for (let i = 0; i < 38; i += 1) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        key += alphabet[seed % alphabet.length];
      }
      expect(admitsKey(key), key).toBe(true);
    }
  });

  it('never repeats a piece of a refused key in the refusal', () => {
    for (const key of [KEY_REFUSED, `xx${KEY_REFUSED.slice(4, 40)}yy`, '‹redacted›-Zq7pX2vK9mWb', 'short-key']) {
      const text = keyRefusedText(key);
      for (const piece of pieces(key)) expect(text, `${key} / ${piece}`).not.toContain(piece);
    }
  });
});
