import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { redactDeep } from '../errors.js';
import { withheldAuditRecord } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import { currentCallContext, currentInstancePolicy, currentRedactor } from './scope.js';

export interface OutlineAuditEvent {
  requestId?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied' | 'rejected';
  target?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
}

/**
 * The audit's code for an error: the HTTP status of an Outline error, `timeout`, or `error`. Only codes from this
 * fixed set are written; the error's message never is.
 */
export function auditErrorCode(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (error instanceof Error && error.name === 'OutlineHttpError' && typeof status === 'number' && Number.isInteger(status)) {
    return `http_${status}`;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'error';
}

/** The key of the caller pseudonyms: random per process, never written anywhere. */
const CALLER_KEY = randomBytes(32);

/** The caller as `hmac:` and 16 hex characters: the same caller gives the same pseudonym within the process. */
export function callerPseudonym(caller: string | undefined): string | undefined {
  if (caller === undefined || caller === '') return undefined;
  return `hmac:${createHmac('sha256', CALLER_KEY).update(caller, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Append one JSON line to OUTLINE_AUDIT_LOG (no-op when unset). Inside a
 * gateway call (always under an InstancePolicy) the record goes to the
 * policy's `audit` sink instead (no-op without one), and OUTLINE_AUDIT_LOG is
 * not read. Caller and request id come from the gateway call's context when
 * there is one.
 *
 * Every string in the record, keys included, has the instance's secrets
 * redacted before it reaches the sink or the file. A failing sink or file
 * throws, so a tool whose start record cannot be written does not run.
 */
export async function writeAuditEvent(event: OutlineAuditEvent): Promise<void> {
  const hosted = currentInstancePolicy();
  const sink = hosted?.audit;
  const auditPath = hosted ? undefined : process.env.OUTLINE_AUDIT_LOG;
  if (!sink && !auditPath) {
    return;
  }

  const context = currentCallContext();
  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? context.requestId ?? randomUUID(),
    tool: event.tool,
    // Only as a pseudonym: the caller is the host's text, often a mail address.
    caller: callerPseudonym(context.caller),
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    status: event.status,
    reason: event.reason,
    // A fixed code, never the error's message.
    error: event.error === undefined ? undefined : auditErrorCode(event.error),
  };
  // Redacted (the call scope's redactor, numbers and depth included), then copied through JSON: plain data, without
  // undefined fields. The second pass is the final one, over the assembled record.
  const safe = JSON.parse(JSON.stringify(redactDeep(redactDeep(record)))) as Record<string, unknown>;

  // The sink check (src/key-admission.ts), on the record and the line in their final form.
  const redactor = currentRedactor();
  const leaks = (value: unknown) => redactor !== undefined && leaksSecret(value, redactor);
  if (sink) {
    await sink(leaks(safe) ? withheldAuditRecord() : safe);
  } else if (auditPath) {
    const line = JSON.stringify(safe);
    await appendFile(auditPath, `${leaks(line) ? JSON.stringify(withheldAuditRecord()) : line}\n`, 'utf8');
  }
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
