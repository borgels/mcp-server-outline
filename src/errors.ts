import { redactRegisteredSecrets, truncate } from './upstream-http.js';

export interface OutlineErrorPayload {
  error?: string;
  message?: string;
  code?: string | number;
}

const SECRET_PATTERNS = [
  /authorization:\s*bearer\s+[^,\s}]+/gi,
  /(apiToken|OUTLINE_API_TOKEN|api_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class OutlineHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: OutlineErrorPayload | unknown;
  readonly retryAfter?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: OutlineErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
  }) {
    super(formatOutlineHttpError(input));
    this.name = 'OutlineHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    redactRegisteredSecrets(value),
  );
}

function formatOutlineHttpError(input: {
  status: number;
  url: string;
  payload?: OutlineErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isOutlineErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `Outline API request failed with HTTP ${input.status}`,
    payload?.code === undefined ? undefined : `code=${truncate(String(payload.code), 64)}`,
    textField(payload?.error),
    textField(payload?.message),
    input.retryAfter ? `retry-after=${truncate(input.retryAfter, 64)}s` : undefined,
    // Redact before truncating, so a secret is never cut in half and left partly visible.
    input.fallbackMessage === undefined ? undefined : truncate(redactSecrets(input.fallbackMessage.trim())),
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function textField(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  return truncate(redactSecrets(String(value)));
}

function isOutlineErrorPayload(value: unknown): value is OutlineErrorPayload {
  return typeof value === 'object' && value !== null;
}
