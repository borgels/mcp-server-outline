/**
 * Secrets of one client, and helpers for calls to the Outline API: redirects are
 * never followed (so credentials are not re-sent to another location), and
 * URLs in error messages carry no query string.
 */

import { currentRedactor } from './outline/scope.js';

/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
export const MIN_SECRET_LENGTH = 8;
/** Any piece of a secret this long or longer is redacted, wherever it appears. */
export const FRAGMENT_LENGTH = 6;
/**
 * What a redacted value is replaced by. Its brackets are not ASCII, so it cannot be a piece of a key issued as
 * ASCII.
 */
export const REDACTION_MARKER = '‹redacted›';

/**
 * The secrets of one client, and so of one gateway or server instance: the
 * exact values (raw, URL-encoded and JSON-escaped) and every fragment of
 * FRAGMENT_LENGTH characters or more of them. Each gateway instance owns its
 * redactor, so a host that runs several tenants in one process never mixes
 * their credentials, and a tenant's credentials and access tokens are
 * released with its instance.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();
  private readonly fragments = new Set<string>();

  /** Redact this value and every piece of it. Values shorter than MIN_SECRET_LENGTH are ignored. */
  addSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    let encoded = value;
    try {
      encoded = encodeURIComponent(value);
    } catch {
      // A lone surrogate has no URL-encoded form; the other forms are still added.
    }
    for (const form of new Set([value, encoded, JSON.stringify(value).slice(1, -1)])) {
      this.secrets.add(form);
      for (let i = 0; i + FRAGMENT_LENGTH <= form.length; i += 1) {
        this.fragments.add(form.slice(i, i + FRAGMENT_LENGTH));
      }
    }
    return this;
  }

  /** Whether the text contains one of the secrets in any form, or any FRAGMENT_LENGTH-character piece of one. */
  matches(text: string): boolean {
    for (const secret of this.secrets) {
      if (text.includes(secret)) return true;
    }
    if (this.fragments.size === 0) return false;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) return true;
    }
    return false;
  }

  /** Every secret value, and every run of text covered by a piece of one, replaced with ‹redacted›. */
  redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join(REDACTION_MARKER);
    }
    return this.redactFragments(result);
  }

  private redactFragments(text: string): string {
    if (this.fragments.size === 0 || text.length < FRAGMENT_LENGTH) {
      return text;
    }
    let covered: Uint8Array | undefined;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) {
        covered ??= new Uint8Array(text.length);
        covered.fill(1, i, i + FRAGMENT_LENGTH);
      }
    }
    if (!covered) {
      return text;
    }
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (covered[i]) {
        out += REDACTION_MARKER;
        while (i < text.length && covered[i]) i += 1;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
  }
}

/**
 * The MCP server's own secrets (the credentials it reads from the
 * environment). Gateway instances never add to it: their calls run in a call
 * scope with their own redactor.
 */
const processRedactor = new SecretRedactor();

/** Redact this exact value in the MCP server's error text (not used by gateway instances). */
export function registerSecret(value: string | undefined): void {
  processRedactor.addSecret(value);
}

/**
 * Replaces the secrets of the instance whose call is in progress with
 * ‹redacted›: inside a gateway call the instance's own redactor, outside one
 * (the MCP server) the server's.
 */
export function redactRegisteredSecrets(value: string): string {
  return (currentRedactor() ?? processRedactor).redact(value);
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Origin and path of a URL, without query string or fragment. */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}
