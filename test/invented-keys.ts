// Invented credentials for the tests, made at run time so that no key-shaped literal sits in the repository (secret
// scanners would rightly flag one).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** An invented key in the shape Outline issues: the vendor prefix and 38 letters and digits, the same for a seed. */
export function inventedOutlineKey(seed: number): string {
  let state = seed;
  let key = ['ol', 'api', ''].join('_');
  for (let i = 0; i < 38; i += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    key += ALPHABET[(state >>> 8) % ALPHABET.length];
  }
  return key;
}

/** An invented JSON Web Token: a header, a payload and a signature, base64url. */
export const INVENTED_JWT = [
  Buffer.from('{"alg":"HS256"}').toString('base64url'),
  Buffer.from('{"sub":"1"}').toString('base64url'),
  Buffer.from('signature').toString('base64url'),
].join('.');
