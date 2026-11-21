import { ConfigError, readEnvInteger } from '../config-env.js';
import { OutlineHttpError, registerSecret, requestIdFrom } from '../errors.js';
import { describeUrl, discardBody, isRedirect, type SecretRedactor } from '../upstream-http.js';
import { isPublicAddress, pinnedFetch, systemResolve, type ResolveHost } from './network.js';

const MAX_TIMEOUT_MS = 10 * 60 * 1000;
/** Largest successful JSON answer a client reads. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Our own text when the connection's check refuses a private or local address. */
export const PRIVATE_ADDRESS_REFUSED = 'Refused: the Outline address points to a private or local network address.';

export interface OutlineClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Embedded (gateway) client: the key goes to `redactor` instead of the
   * process-wide registry, nothing is read from the environment, the base URL
   * must already be normalised by normalizeOutlineBaseUrl, every connection
   * goes only to public addresses (DNS checked), an answer that is not JSON
   * is refused, and a throttled request is not retried.
   */
  embedded?: { redactor: SecretRedactor; resolveHost?: ResolveHost };
}

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Client for the Outline API. Outline is RPC-over-HTTP: every endpoint is
 * POST /api/<resource>.<method> with a JSON body, including reads. Auth is a
 * Bearer token that inherits the creating user's permissions. Lists use
 * {limit, offset} and return {data, pagination:{offset,limit,nextPath}}.
 *
 * Redirects are never followed and Outline's error bodies are never read:
 * errors are our own text with the HTTP status first.
 */
export class OutlineClient {
  private readonly apiToken?: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly embedded?: { resolveHost: ResolveHost; hostFetch: boolean };

  constructor(options: OutlineClientOptions = {}) {
    if (options.embedded) {
      this.apiToken = options.apiToken;
      options.embedded.redactor.addSecret(this.apiToken);
      const resolveHost = options.embedded.resolveHost ?? systemResolve;
      this.embedded = { resolveHost, hostFetch: options.fetchImpl !== undefined };
      const root = trimTrailingSlash(options.baseUrl ?? '');
      if (!root) {
        throw new Error('No Outline address is configured for this connection.');
      }
      this.baseUrl = `${root}/api`;
      // The built-in fetch connects only to public addresses, checked for every new connection (network.ts).
      this.fetchImpl = options.fetchImpl ?? pinnedFetch(resolveHost);
      this.timeoutMs = options.timeoutMs ?? 30_000;
    } else {
      this.apiToken = options.apiToken ?? process.env.OUTLINE_API_TOKEN;
      registerSecret(this.apiToken);
      const root = trimTrailingSlash(options.baseUrl ?? process.env.OUTLINE_BASE_URL ?? '');
      if (!root) {
        throw new Error('Missing OUTLINE_BASE_URL (e.g. https://outline.example.com).');
      }
      assertSafeBaseUrl(root);
      this.baseUrl = root.endsWith('/api') ? root : `${root}/api`;
      this.fetchImpl = options.fetchImpl ?? fetch;
      this.timeoutMs = options.timeoutMs ?? readEnvInteger('OUTLINE_TIMEOUT_MS', 30_000, { min: 1, max: MAX_TIMEOUT_MS });
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new ConfigError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }
  }

  /**
   * Call POST /api/<method> with a JSON body. The MCP server retries once on
   * 429 honoring Retry-After; an embedded client leaves that to its host.
   */
  async call<T = unknown>(method: string, body: Record<string, unknown> = {}, isRetry = false): Promise<T> {
    if (!this.apiToken) {
      throw new Error(
        this.embedded
          ? 'No Outline API key is configured for this connection.'
          : 'Missing OUTLINE_API_TOKEN. Set it in the MCP server environment.',
      );
    }
    if (!/^[a-zA-Z]+\.[a-zA-Z_]+$/.test(method)) {
      throw new Error('Refusing to call a non-standard Outline method.');
    }

    const url = `${this.baseUrl}/${method}`;
    const response = await this.send(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify(body),
      // Never follow redirects: the key and the request body would be re-sent to the new location.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.type === 'opaqueredirect' || isRedirect(response.status)) {
      await discardBody(response);
      throw new Error(
        `Outline API responded with a redirect (HTTP ${response.status}); redirects are not followed. ` +
          'Check that the Outline address is the final https:// address of the workspace.',
      );
    }

    if (response.status === 429 && !isRetry && !this.embedded) {
      await discardBody(response);
      const retryAfter = Number(response.headers.get('retry-after') ?? 1);
      const seconds = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 10) : 1;
      await new Promise(r => setTimeout(r, seconds * 1000));
      return this.call<T>(method, body, true);
    }

    if (!response.ok) {
      // The body is never read: Outline's text never becomes part of an error.
      await discardBody(response);
      throw new OutlineHttpError({
        status: response.status,
        url: describeUrl(url),
        retryAfter: response.headers.get('retry-after') ?? undefined,
        requestId: requestIdFrom(response.headers),
      });
    }
    return (await this.readBody(response)) as T;
  }

  /** Fetch every page of a list method (bounded), concatenating `data`. */
  async listAll<T = unknown>(
    method: string,
    body: Record<string, unknown> = {},
    maxPages = 10,
  ): Promise<{ data: T[]; pagesFetched: number; more: boolean }> {
    const limit = Math.min(Number(body.limit ?? 25), 100);
    const out: T[] = [];
    let offset = Number(body.offset ?? 0);
    let pages = 0;
    let more = false;
    for (; pages < maxPages; ) {
      const resp = await this.call<{ data?: T[]; pagination?: { nextPath?: string } }>(method, { ...body, limit, offset });
      out.push(...(resp.data ?? []));
      pages += 1;
      if (!resp.pagination?.nextPath || (resp.data?.length ?? 0) < limit) {
        break;
      }
      offset += limit;
      if (pages >= maxPages) {
        more = true;
      }
    }
    return { data: out, pagesFetched: pages, more };
  }

  /** The request, with network failures and timeouts in our own words (no address, no cause text). */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      if (this.embedded?.hostFetch) {
        // The host's fetch connects by itself: the name is checked here, before every request.
        await this.assertPublicHost(new URL(url).hostname);
      }
      return await this.fetchImpl(url, init);
    } catch (error) {
      throw this.transportError(error);
    }
  }

  private async assertPublicHost(hostname: string): Promise<void> {
    let addresses: readonly string[];
    try {
      addresses = await this.embedded!.resolveHost(hostname);
    } catch {
      throw Object.assign(new Error('The Outline address could not be resolved.'), { code: 'ENOTFOUND' });
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw Object.assign(new Error(PRIVATE_ADDRESS_REFUSED), { code: 'ERR_OUTLINE_PRIVATE_ADDRESS' });
    }
  }

  private transportError(error: unknown): Error {
    if (error instanceof OutlineHttpError) {
      return error;
    }
    if (isTimeoutError(error)) {
      return Object.assign(new Error(`Outline API request timed out after ${this.timeoutMs} ms.`), {
        name: 'TimeoutError',
      });
    }
    const codes = causeCodes(error);
    if (codes.includes('ERR_OUTLINE_PRIVATE_ADDRESS')) {
      return new Error(PRIVATE_ADDRESS_REFUSED);
    }
    const shown = codes.find(code => SHOWN_NETWORK_CODES.has(code));
    return new Error(`Network error calling the Outline API${shown ? ` (${shown})` : ''}.`);
  }

  private async readBody(response: Response): Promise<unknown> {
    let read: { bytes: Uint8Array; exceeded: boolean };
    try {
      read = await readUpTo(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw this.transportError(error);
    }
    if (read.exceeded) {
      throw new Error(`The Outline answer exceeds the ${MAX_RESPONSE_BYTES} byte limit.`);
    }
    const text = new TextDecoder().decode(read.bytes);
    if (!text.trim()) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (!this.embedded) {
        return text;
      }
      // Never passed on as text: an answer that is not JSON is not what the API documents.
      throw new Error('Outline answered with something that is not JSON; nothing of it is passed on.');
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** The `code` of an error and of every cause below it. */
function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('OUTLINE_BASE_URL is not a valid URL.');
  }
  if (parsed.protocol === 'https:') {
    return;
  }
  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }
  throw new Error(
    `Refusing to send the Outline token over ${parsed.protocol}//. Use https:// (loopback http:// allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
