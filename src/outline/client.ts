import { OutlineHttpError } from '../errors.js';

export interface OutlineClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Client for the Outline API. Outline is RPC-over-HTTP: every endpoint is
 * POST /api/<resource>.<method> with a JSON body, including reads. Auth is a
 * Bearer token that inherits the creating user's permissions. Lists use
 * {limit, offset} and return {data, pagination:{offset,limit,nextPath}}.
 */
export class OutlineClient {
  private readonly apiToken?: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OutlineClientOptions = {}) {
    this.apiToken = options.apiToken ?? process.env.OUTLINE_API_TOKEN;
    const root = trimTrailingSlash(options.baseUrl ?? process.env.OUTLINE_BASE_URL ?? '');
    if (!root) {
      throw new Error('Missing OUTLINE_BASE_URL (e.g. https://playbook.example.com).');
    }
    assertSafeBaseUrl(root);
    this.baseUrl = root.endsWith('/api') ? root : `${root}/api`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.OUTLINE_TIMEOUT_MS ?? 30_000);
  }

  /** Call POST /api/<method> with a JSON body. Retries once on 429 honoring Retry-After. */
  async call<T = unknown>(method: string, body: Record<string, unknown> = {}, isRetry = false): Promise<T> {
    if (!this.apiToken) {
      throw new Error('Missing OUTLINE_API_TOKEN. Set it in the MCP server environment.');
    }
    if (!/^[a-zA-Z]+\.[a-zA-Z_]+$/.test(method)) {
      throw new Error(`Refusing to call non-standard Outline method: ${method}`);
    }

    const url = `${this.baseUrl}/${method}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 429 && !isRetry) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 1);
      await new Promise(r => setTimeout(r, Math.min(retryAfter, 10) * 1000));
      return this.call<T>(method, body, true);
    }

    const payload = await readBody(response);
    if (!response.ok) {
      throw new OutlineHttpError({
        status: response.status,
        url,
        payload,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof payload === 'string' ? payload : undefined,
      });
    }
    return payload as T;
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
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
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
    throw new Error(`OUTLINE_BASE_URL is not a valid URL: ${baseUrl}`);
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
