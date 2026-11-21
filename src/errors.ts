/**
 * Errors and redaction.
 *
 * The rule: no text Outline controls ever reaches a host, a result or an
 * audit record through an error. An HTTP error carries the status, our own
 * hint and the parsed Retry-After; never a response body, an error message
 * from Outline, or a redirect's Location. Outline's text can quote the
 * request or part of a credential, and no redactor recognises every fragment.
 *
 * Redaction is the second line: the secrets of the instance in scope (the API
 * key: exact value, encoded forms and any fragment of FRAGMENT_LENGTH
 * characters or more) are redacted from everything returned, on structured
 * values before they are serialised.
 */
import { redactRegisteredSecrets } from './upstream-http.js';

export { describeUrl, FRAGMENT_LENGTH, MIN_SECRET_LENGTH, registerSecret } from './upstream-http.js';

/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;

export interface OutlineHttpErrorInput {
  status: number;
  url: string;
  retryAfter?: string;
  /** Outline's own id for the request, from a response header; kept only as a UUID or hex id. */
  requestId?: string;
}

const SECRET_PATTERNS = [
  // A scheme word in any case before a value that holds the marker of an earlier redaction: the scheme word and the
  // whole value up to a space, quote, comma or brace, whatever its length.
  /\b(bearer|basic)\s+[^\s"',}]*‹redacted›[^\s"',}]*/gi,
  /Authorization:\s*(Bearer|Basic|Token)\s+[^,\s}]+/gi,
  // An Outline API key anywhere (another user's, quoted in a document): the vendor prefix and what follows.
  /\bol_api_(?:[A-Za-z0-9]|‹redacted›)+/g,
  // A credential-named assignment in text: `X-Api-Key: S`, `api_token=S`, `?access_token=S`, `"apiToken": "S"`.
  /(OUTLINE_API_TOKEN|MCP_HTTP_TOKEN|(?:x[-_]?)?api[-_]?(?:key|token|secret)|client[-_]?secret|(?:access|refresh|auth|id|session|bearer)[-_]?token|accessToken|apiKey|apiToken|token|password|passwd|secret)["']?\s*[:=]\s*["']?[^"',\s}&]+/gi,
  // A marker left by the secrets' redaction (‹redacted›) counts as part of a value, so the rest of it is masked too.
  /\b(Bearer|Basic)\s+(?:[A-Za-z0-9._~+/-]|‹redacted›)+=*/g,
  // Any case ("bearer", "BASIC"), when what follows looks like a token: 8 or more base64 or base64url characters. A
  // short word after "basic" ("basic plan") is left alone; a longer one is masked, a false positive we accept.
  /\b(bearer|basic)\s+(?:[A-Za-z0-9._~+/-]|‹redacted›){8,}=*/gi,
  // A JSON Web Token anywhere: three base64url segments, the first a JSON header ("eyJ").
  /\beyJ(?:[A-Za-z0-9_-]|‹redacted›)*\.(?:[A-Za-z0-9_-]|‹redacted›)+\.(?:[A-Za-z0-9_-]|‹redacted›)*/g,
];

/** Our own guidance per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
  400: 'Outline refused the values. Check the ids and fields.',
  401: 'Outline rejected the API key (invalid, expired or revoked). Retrying will not help.',
  403: 'The Outline user behind the API key, or the key itself, has no permission for this. Retrying will not help.',
  404: 'Outline found nothing with this id. Check the ids.',
  429: 'Outline is throttling requests. Wait and retry later.',
};

/**
 * An HTTP error from Outline: the status, our own hint, the parsed
 * Retry-After and Outline's request id (only in the form such ids have, see
 * requestIdFrom). Nothing of the body is kept or read.
 */
export class OutlineHttpError extends Error {
  readonly status: number;
  /** Origin and path of the request, without query string. Not part of the message. */
  readonly url: string;
  /** Seconds to wait, parsed from Retry-After; undefined when absent or not a number of seconds. */
  readonly retryAfter?: string;
  /** Outline's own id for the request, when a response header gives one as a UUID or hex id. */
  readonly requestId?: string;

  constructor(input: OutlineHttpErrorInput) {
    const retryAfter = wholeNumber(input.retryAfter);
    super(
      [
        `Outline API request failed with HTTP ${input.status}`,
        Object.hasOwn(STATUS_HINTS, input.status) ? STATUS_HINTS[input.status] : undefined,
        retryAfter === undefined ? undefined : `retry-after=${retryAfter}s`,
      ]
        .filter(Boolean)
        .join(' | '),
    );
    this.name = 'OutlineHttpError';
    this.status = input.status;
    this.url = input.url;
    this.retryAfter = retryAfter;
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * A redirect from Outline, refused (it is never followed): our own text, the status of the answer and its request
 * id, nothing else of the response.
 */
export class OutlineRedirectError extends Error {
  readonly status: number;
  /** Outline's own id for the request, when a response header gives one as a UUID or hex id. */
  readonly requestId?: string;

  constructor(message: string, input: { status: number; requestId?: string }) {
    super(message);
    this.name = 'OutlineRedirectError';
    this.status = input.status;
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * Response headers that carry the vendor's own id for a request, most specific first. Outline documents no header of its own, so
 * this is the common list.
 */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-ms-request-id',
  'x-amzn-requestid',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/**
 * The vendor's request id, only in the form such ids have (a UUID or a hex id of 8 to 64 characters), or
 * undefined. Anything else, and an id that holds the shape of a personal number, is dropped: the value comes from
 * the vendor and is kept only when it cannot be text.
 */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status Outline answered with and its
 * request id. Never the response body, the vendor's error code or message, or the input.
 */
export interface FailureMetadata {
  /** The HTTP status of Outline's answer (100-599). */
  httpStatus: number;
  /** The vendor's own id for the request, as a UUID or hex id only. */
  requestId?: string;
}

/**
 * The failure metadata of an error: an HTTP error from Outline (a refused redirect included) gives its status and
 * request id.
 */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  if (!(error instanceof OutlineHttpError) && !(error instanceof OutlineRedirectError)) return undefined;
  const status: unknown = error.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(error.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

/**
 * Credential-shaped text first, while it is whole: an instance secret replaced inside a Bearer value would break the
 * match and leave the rest of the value. Then the instance's secrets, then the patterns again (they also take the
 * marker as part of a value), until nothing changes.
 */
export function redactSecrets(value: string): string {
  let result = redactCredentialPatterns(value);
  for (let round = 0; round < 4; round += 1) {
    const next = redactCredentialPatterns(redactRegisteredSecrets(result));
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * Credential-shaped text replaced by a marker: an Authorization header, a
 * Bearer or Basic value, an Outline API key, and `token=`/`apiKey:`-style
 * assignments. Applied to every text a gateway returns, so a credential the
 * upstream echoes (one that is not the instance's own key) never leaves it.
 * Uses no state: the same input always gives the same output.
 */
export function redactCredentialPatterns(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        if (/^eyJ/.test(match) || /^ol_api_/.test(match)) {
          return '[REDACTED]';
        }

        if (/^(Bearer|Basic)\s/i.test(match)) {
          const scheme = match.split(/\s+/)[0] ?? 'Authorization';
          return `${scheme} [REDACTED]`;
        }

        if (/^Authorization:/i.test(match)) {
          return 'Authorization: [REDACTED]';
        }

        // The first separator ends the name: everything after it is the value, which may itself hold `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} [REDACTED]`;
      }),
    value,
  );
}

/**
 * Copy of a JSON-like value with every string, object keys included, passed
 * through redactSecrets. Redact a value with this before it is serialised:
 * a serialised secret is escaped, and the escaped form is easy to miss.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced, never passed on.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactSecrets(text) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactDeep(entry, depth + 1)]),
  );
}

/** A header value that is a whole number of at most 9 digits, as text; anything else is dropped. */
function wholeNumber(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{1,9}$/.test(trimmed) ? String(Number(trimmed)) : undefined;
}
