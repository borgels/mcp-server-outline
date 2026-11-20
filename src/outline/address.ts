import ipaddr from 'ipaddr.js';
import { GatewayConfigError } from './scope.js';

/**
 * The customer's Outline address as an embedded gateway accepts it: https, a
 * public host name and nothing else. Pure (no network): a host can call
 * normalizeOutlineBaseUrl before it stores an address. Where the name points
 * is checked when a connection is made (network.ts): every address the name
 * resolves to must be public.
 */

/** Every refusal starts with this text; the value given is never quoted. */
export const ADDRESS_REFUSED = 'Outline address refused:';

/** Host name suffixes of local and internal networks. */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.intranet', '.corp', '.test', '.invalid'];

const MAX_ADDRESS_LENGTH = 2048;

function refuse(reason: string): never {
  throw new GatewayConfigError(`${ADDRESS_REFUSED} ${reason}`);
}

/**
 * Check an Outline address and return it normalised as `https://<host>` (lower
 * case, no trailing slash or dot). Accepted: `https://` followed by a public
 * DNS host name, optionally with a trailing `/`. Refused, with a
 * GatewayConfigError whose message starts with ADDRESS_REFUSED: anything that
 * is not https, a user name or password, a port, a path, a query string or a
 * fragment, an IP address, and a local or single-label name. The client adds
 * `/api/v1` itself.
 */
export function normalizeOutlineBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ADDRESS_LENGTH) {
    refuse('give the address as text, for example https://team.getoutline.com.');
  }
  const text = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    refuse('it is not a valid address, for example https://team.getoutline.com.');
  }
  if (parsed.protocol !== 'https:') {
    refuse('it must start with https://.');
  }
  if (parsed.username !== '' || parsed.password !== '' || /^https:\/\/[^/]*@/i.test(text)) {
    refuse('it must not contain a user name or password.');
  }
  if (text.includes('?') || text.includes('#') || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    refuse('it must be the host name only, without a path, query string or fragment.');
  }
  if (parsed.port !== '') {
    refuse('it must not name a port.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === '' ||
    host === 'localhost' ||
    isIpLiteral(host) ||
    !host.includes('.') ||
    LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix)) ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    refuse('it must be a public host name, not an IP address or a local name.');
  }
  return `https://${host}`;
}

function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return host.startsWith('[') || ipaddr.isValid(bare) || /^[0-9.]+$/.test(bare) || /^0x/i.test(bare);
}
