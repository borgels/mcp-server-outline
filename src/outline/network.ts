import type { LookupAddress, LookupOptions } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Where an Outline instance may be reached: only a public unicast address. The address is
 * parsed (ipaddr.js), not compared as text, so every spelling of an address
 * is classified alike: `::1`, `0:0:0:0:0:0:0:1`, `::ffff:7f00:1` and
 * `::ffff:127.0.0.1` are all loopback. An IPv4 address embedded in IPv6
 * (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo) is checked as IPv4.
 * Anything ipaddr.js does not call `unicast` (private, loopback, link-local,
 * carrier-grade NAT, unique local, multicast, reserved, benchmarking,
 * documentation ranges, ...) is refused, as is anything that does not parse.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  } catch {
    return false;
  }
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    const embedded = embeddedIPv4(v6);
    if (embedded) return embedded.range() === 'unicast';
    return v6.range() === 'unicast';
  }
  return parsed.range() === 'unicast';
}

/** The IPv4 address inside an IPv6 address that carries one, or undefined. */
function embeddedIPv4(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  const parts = address.parts;
  const fromWords = (high: number, low: number) =>
    new ipaddr.IPv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);
  const range = address.range();
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible, deprecated), 64:ff9b::a.b.c.d (NAT64), ::ffff:0:a.b.c.d (rfc6145).
  if (address.isIPv4MappedAddress()) return address.toIPv4Address();
  if (range === 'rfc6052' || range === 'rfc6145') return fromWords(parts[6]!, parts[7]!);
  if (parts.slice(0, 6).every(part => part === 0) && (parts[6] !== 0 || parts[7]! > 1)) return fromWords(parts[6]!, parts[7]!);
  // 6to4: 2002:AABB:CCDD::/16 carries AA.BB.CC.DD.
  if (range === '6to4') return fromWords(parts[1]!, parts[2]!);
  // Teredo: 2001:0::/32 carries the client address, inverted, in the last 32 bits.
  if (range === 'teredo') return fromWords(parts[6]! ^ 0xffff, parts[7]! ^ 0xffff);
  return undefined;
}

/** Thrown from the connection's lookup when the Outline host name points to an address that is not public. */
export class PrivateAddressError extends Error {
  readonly code = 'ERR_OUTLINE_PRIVATE_ADDRESS';
  constructor() {
    super('Refused: the Outline address points to a private or local network address.');
    this.name = 'PrivateAddressError';
  }
}

export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for net/tls connections that resolves the name and refuses the
 * connection when any address is not public. It runs for every new
 * connection, and the socket connects to the address it returns: the address
 * checked is the address used, so a name whose DNS answer changes between
 * two connections (DNS rebinding) is checked again each time. TLS still
 * verifies the certificate against the host name (SNI and Host are the name).
 */
export function pinnedLookup(resolve: ResolveHost) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname).then(
      addresses => {
        if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
          callback(new PrivateAddressError() as NodeJS.ErrnoException, '');
          return;
        }
        const entries = addresses.map(address => ({ address, family: ipaddr.parse(address).kind() === 'ipv6' ? 6 : 4 }));
        const wanted = options.family === 4 || options.family === 6 ? entries.filter(entry => entry.family === options.family) : entries;
        if (wanted.length === 0) {
          callback(Object.assign(new Error('No address of the requested family.'), { code: 'ENOTFOUND' }), '');
          return;
        }
        if (options.all) callback(null, wanted);
        else callback(null, wanted[0]!.address, wanted[0]!.family);
      },
      () => callback(Object.assign(new Error('The Outline address could not be resolved.'), { code: 'ENOTFOUND' }), ''),
    );
  };
}

/** The system resolver: every address the name has. */
export async function systemResolve(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import('node:dns/promises');
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(answer => answer.address);
}

/**
 * A fetch whose connections go only to public addresses of the Outline host, checked
 * per connection by pinnedLookup. Each client gets its own dispatcher.
 */
export function pinnedFetch(resolve: ResolveHost): typeof fetch {
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(resolve) } });
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as string, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}
