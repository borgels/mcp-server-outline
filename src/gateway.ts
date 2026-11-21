import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  failureMetadata,
  formatUnknownError,
  MAX_REDACT_DEPTH,
  redactCredentialPatterns,
  vendorRequestId,
  type FailureMetadata,
} from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, KEY_REFUSED, leaksSecret, maskedText, sealedError } from './key-admission.js';
import { GATEWAY_UPSTREAM, registerOutlineGatewayTools } from './tools/gateway-tools.js';
import { normalizeOutlineBaseUrl } from './outline/address.js';
import { writeAuditEvent } from './outline/audit.js';
import { OutlineClient, type OutlineClientOptions } from './outline/client.js';
import type { ResolveHost } from './outline/network.js';
import {
  canonicalToolName,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './outline/scope.js';
import { REDACTION_MARKER, SecretRedactor } from './upstream-http.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Schemas, handlers, policy checks and audit
 * live in src/tools/gateway-tools.ts and are shared with the MCP server's
 * modules.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the API key and the Outline address passed
 * to createOutlineGateway and reads no OUTLINE_* variable at all: not the key
 * (OUTLINE_API_TOKEN), not the address (OUTLINE_BASE_URL), not
 * OUTLINE_ENABLE_WRITES (the host's policy decides), not OUTLINE_TIMEOUT_MS
 * (30 seconds unless `timeoutMs` is given), and not OUTLINE_AUDIT_LOG. Every
 * call runs as the user who owns the API key.
 *
 * The address must be https and a public host name (normalizeOutlineBaseUrl):
 * Outline Cloud (https://<team>.getoutline.com) or a self-hosted address.
 * Every connection goes only to public addresses: the host name is resolved
 * and each address checked before a connection is made, and redirects are
 * never followed.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`; without it the instance uses the default policy (no
 * writes, no disabled tools, no audit records).
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), so a call
 * made from inside another instance's call (from its audit sink or its fetch)
 * never inherits that instance's policy, sink, redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './outline/scope.js';
export { GatewayConfigError } from './outline/scope.js';
export { ADDRESS_REFUSED, normalizeOutlineBaseUrl } from './outline/address.js';
export { PRIVATE_ADDRESS_REFUSED } from './outline/client.js';
export { KEY_REFUSED } from './key-admission.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Outline answered with,
 * and its own request id when a response header gives one as a UUID or hex id. For a host that counts failures
 * without reading their text. Never the response body, the vendor's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from Outline only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

/** Who and which request a call belongs to; written to the audit records of the call. */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/**
 * One Outline API request a tool may make: the method and the path on the customer's Outline address. Outline's API
 * is RPC over HTTP, so every request is a POST to /api/<resource>.<method>, reads included.
 */
export interface GatewayUpstreamOperation {
  readonly method: 'POST';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Outline request the tool may make. Empty for a tool that does not call Outline. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). No Outline gateway tool is broad.
   */
  readonly broad: boolean;
}

export interface OutlineGatewayOptions {
  /**
   * The customer's Outline API key (Settings, API & Apps; it starts with the vendor prefix), sent as
   * `Authorization: Bearer`. Required; never read from the environment.
   */
  apiToken: string;
  /**
   * The customer's Outline address, e.g. https://team.getoutline.com or a self-hosted https address. Required;
   * never read from the environment. Checked with normalizeOutlineBaseUrl; the client adds /api.
   */
  baseUrl: string;
  /**
   * The fetch to use. Without it the built-in fetch connects only to the
   * public addresses it checked. With it, the host name is still resolved and
   * checked before every request.
   */
  fetchImpl?: typeof fetch;
  /** Time limit per Outline request in milliseconds. Default 30 seconds; never read from the environment. */
  timeoutMs?: number;
  /** Resolves the host name to its addresses (default: the system resolver). For tests and custom DNS. */
  resolveHost?: ResolveHost;
  /**
   * Instance policy from the host. Without it the instance uses the default
   * policy (no writes, no disabled tools, no audit records); it never reads
   * a policy or audit variable from the environment.
   */
  policy?: InstancePolicy;
}

/** Time limit per Outline request when the host gives none. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The gateway's tools, with their own titles and descriptions. Their Outline requests are in GATEWAY_UPSTREAM. */
const GATEWAY_TOOLS: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  /** The first line of a successful result's text. */
  summary: string;
  broad?: boolean;
}> = [
  {
    name: 'search_capabilities',
    title: 'Search Outline capabilities',
    description: 'Find the Outline tools this connection offers, with examples.',
    riskLevel: 'read',
    summary: 'Outline capabilities.',
  },
  {
    name: 'check_connection',
    title: 'Check Outline connection',
    description: 'Verify that Outline accepts the API key, and show the name and role of the user it belongs to and the name of the workspace.',
    riskLevel: 'read',
    summary: 'Outline connection checked.',
  },
  {
    name: 'search_documents',
    title: 'Search Outline documents',
    description: 'Full-text search in the documents the user can read, ranked by relevance, with a context snippet per hit. Optionally within one collection.',
    riskLevel: 'read',
    summary: 'Outline search results.',
  },
  {
    name: 'list_documents',
    title: 'List Outline documents',
    description: 'List published documents, most recently updated first, optionally in one collection or under one parent document. Without their text.',
    riskLevel: 'read',
    summary: 'Outline documents.',
  },
  {
    name: 'get_document',
    title: 'Get Outline document',
    description: 'Fetch one document by id or url slug, with its text as Markdown.',
    riskLevel: 'read',
    summary: 'Outline document.',
  },
  {
    name: 'list_collections',
    title: 'List Outline collections',
    description: 'List the collections (top-level knowledge areas) the user can see.',
    riskLevel: 'read',
    summary: 'Outline collections.',
  },
  {
    name: 'get_collection',
    title: 'Get Outline collection',
    description: 'Fetch one collection; includeStructure adds its tree of document titles.',
    riskLevel: 'read',
    summary: 'Outline collection.',
  },
  {
    name: 'list_comments',
    title: 'List Outline comments',
    description: 'List the comments on one document, as plain text with author and time.',
    riskLevel: 'read',
    summary: 'Outline comments.',
  },
  {
    name: 'list_revisions',
    title: 'List Outline revisions',
    description: 'List the version history of one document: title, author and time of each version, without its text.',
    riskLevel: 'read',
    summary: 'Outline revisions.',
  },
  {
    name: 'create_document',
    title: 'Create Outline document',
    description:
      'Create a document with a title and a Markdown text in a collection, optionally under a parent document. It stays a draft only the user sees unless publish is true; a published document is visible to everyone who can read the collection.',
    riskLevel: 'write',
    summary: 'Outline document created.',
  },
  {
    name: 'update_document',
    title: 'Update Outline document',
    description:
      'Change a document’s title and/or text. By default the text is added to the end (textMode "append"); textMode "replace" replaces the whole text. Outline keeps the earlier version in the document history.',
    riskLevel: 'write',
    summary: 'Outline document updated.',
  },
  {
    name: 'create_comment',
    title: 'Comment on Outline document',
    description: 'Add a comment to a document, or reply to a comment with parentCommentId. Everyone who can read the document sees it.',
    riskLevel: 'write',
    summary: 'Outline comment added.',
  },
];

type RegisteredHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  inputSchema: z.ZodType;
  handler: RegisteredHandler;
}

/**
 * The gateway's tools as registered: the zod input schema (strict: an
 * unknown field is refused, not dropped) and the handler bound to `client`.
 */
function registeredTools(client: OutlineClient): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: { inputSchema?: z.ZodRawShape }, handler: RegisteredHandler): void {
      tools.set(name, { inputSchema: z.strictObject(config.inputSchema ?? {}), handler });
    },
  };
  registerOutlineGatewayTools(server as never, client);
  return tools;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` is dropped: validators such as Ajv reject
 * unknown formats in strict mode, and zod checks the values when the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
      delete (ctx.jsonSchema as Record<string, unknown>).pattern;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// Schemas only: registration binds the handlers to a client but never calls it.
const schemas = registeredTools(
  new OutlineClient({
    apiToken: 'schema-only',
    baseUrl: 'https://schema.invalid',
    timeoutMs: 1,
    fetchImpl: () => Promise.reject(new Error('schema only')),
    embedded: { redactor: new SecretRedactor(), resolveHost: async () => [] },
  }),
);

function definition(tool: (typeof GATEWAY_TOOLS)[number]): GatewayToolDefinition {
  const registered = schemas.get(`${TOOL_PREFIX}${tool.name}`);
  if (!registered) {
    throw new Error(`Outline gateway tool is not registered: ${tool.name}`);
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(registered.inputSchema),
  };
}

/** All gateway tools, as definitions (names without the prefix). */
export const outlineGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `outlineGatewayTools` and deeply frozen. Hosts can use it to build their own
 * permission model without creating a gateway instance.
 */
export const outlineToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: (GATEWAY_UPSTREAM[tool.name] ?? []).map(method => ({ method: 'POST' as const, path: `/api/${method}` })),
    broad: tool.broad === true,
  })),
);

const GATEWAY_TOOL_NAMES: readonly string[] = GATEWAY_TOOLS.map(tool => `${TOOL_PREFIX}${tool.name}`);
const SUMMARIES: ReadonlyMap<string, string> = new Map(
  GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, tool.summary]),
);

/** KEY_REFUSED with every run that shares a piece with any of the secrets masked, so it holds no piece of one. */
function refusedText(field: string, secrets: readonly unknown[]): string {
  return secrets.reduce<string>((text, secret) => maskedText(text, secret), `${field}: ${KEY_REFUSED}`);
}

function requiredToken(options: OutlineGatewayOptions | undefined, given: readonly unknown[]): string {
  const apiToken: unknown = options?.apiToken;
  if (typeof apiToken !== 'string' || apiToken.trim() === '') {
    throw new GatewayConfigError(
      'createOutlineGateway requires options.apiToken. Embedded instances do not read credentials from the environment.',
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from it; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(apiToken.trim())) throw new GatewayConfigError(refusedText('options.apiToken', given));
  return apiToken.trim();
}

/** A caller id from the host: redacted before it is cut short, so no part of a secret survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance. `apiToken` and `baseUrl` are required and are
 * the only connection settings the instance uses; a missing or refused value
 * fails here, before anything is built or sent. Where the address points is
 * checked when a connection is made (first call).
 */
export function createOutlineGateway(options: OutlineGatewayOptions) {
  let token: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const raw = options as Partial<OutlineGatewayOptions> | undefined;
  const secrets = typeof raw?.apiToken === 'string' ? [raw.apiToken, raw.apiToken.trim()] : [];
  try {
    // Admission first, before a redactor is built from the token.
    token = requiredToken(options, secrets);
    guard = new SecretRedactor().addSecret(token);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the token.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    const gateway = buildOutlineGateway(options, token, guard);
    // The tool list leaves the gateway as it is: a token that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && token !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the token becomes
      // the fixed refusal.
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = refusedText('options', secrets);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the token. Then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && token !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(refusedText('options', secrets)), ...secrets);
    }
    throw final;
  }
}

function buildOutlineGateway(options: OutlineGatewayOptions, apiToken: string, redactor: SecretRedactor) {
  // Only these options are read; anything else a host passes is dropped.
  const { policy: hostPolicy, baseUrl, fetchImpl, timeoutMs, resolveHost } = options;
  const address = normalizeOutlineBaseUrl(baseUrl);
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new GatewayConfigError('options.fetchImpl must be a function.');
  }
  if (resolveHost !== undefined && typeof resolveHost !== 'function') {
    throw new GatewayConfigError('options.resolveHost must be a function.');
  }
  // Always a policy: the host's, or the default one. A gateway call never reads policy or audit variables.
  const policy: ResolvedInstancePolicy = resolveInstancePolicy(hostPolicy ?? {}, GATEWAY_TOOL_NAMES);
  const clientOptions: OutlineClientOptions = {
    apiToken,
    baseUrl: address,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
    embedded: { redactor, ...(resolveHost ? { resolveHost } : {}) },
  };
  const client = new OutlineClient(clientOptions);
  const handlers = registeredTools(client);
  const offeredTools: ReadonlySet<string> = new Set(GATEWAY_TOOL_NAMES.filter(name => !policy.disabledTools.has(name)));

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: outlineGatewayTools.filter(tool => !policy.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // Every call in a scope of its own.
      return runInCallScope(
        {
          policy,
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          offeredTools,
        },
        // A successful result is already redacted as data by normalizeResult, and its JSON text is built from that
        // data. An error result is our own text, and is redacted as a whole.
        () =>
          runCall(toolName, input).then(result => {
            // The failure metadata is checked again after redaction: an id that redaction changed is dropped.
            const final = withFailureInForm(
              result.isError ? (redactDeep(result, redactor) as GatewayToolResult) : result,
            );
            // The sink check, as the very last step: a result that holds a piece of the token anywhere, outer fields
            // and the JSON text included, is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = GATEWAY_TOOL_NAMES.includes(name) ? handlers.get(name) : undefined;
      if (!tool) {
        // Neither the audit record nor the answer repeats the name: it is the caller's text, not ours.
        await writeAuditEvent({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Outline gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        const short = name.slice(TOOL_PREFIX.length);
        return errorResult(formatUnknownError(`Invalid input for ${short}: ${z.prettifyError(parsed.error)}`));
      }

      const result = await tool.handler(parsed.data as Record<string, unknown>);
      return normalizeResult(result, redactor, SUMMARIES.get(name) ?? 'Outline gateway result.');
    } catch (error) {
      return errorResult(formatUnknownError(error), failureMetadata(error));
    }
  }
}

/**
 * Field names whose value is a credential whatever it looks like: the value of
 * such a field is replaced whole, not only when it matches a pattern.
 */
const CREDENTIAL_NAME =
  /^x?(authorization|proxyauthorization|cookie|setcookie|(access|refresh|id|session|bearer|auth|api|private|secret|subscription)(token|key)|token|apisecret|clientsecret|secret|password|passwd|credentials?)$/;

/** Whether a field name names a credential, however it is written (case, `-`, `_`, spaces, a leading `x-`). */
function isCredentialField(name: string): boolean {
  return CREDENTIAL_NAME.test(name.toLowerCase().replace(/[-_\s.]/g, ''));
}

/**
 * One text as a gateway may return it: credential-shaped text masked, then the instance's own secrets, then the
 * patterns again (they take the marker as part of a value), until nothing changes.
 */
function redactText(value: string, redactor: SecretRedactor): string {
  let result = redactCredentialPatterns(value);
  for (let round = 0; round < 4; round += 1) {
    const next = redactCredentialPatterns(redactor.redact(result));
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * A copy of a JSON value with every string, object keys included, passed
 * through the credential patterns and the redactor, the value of every
 * credential-named field replaced whole, whatever its type, and every number
 * or boolean whose string form would be redacted replaced by the string
 * "‹redacted›". Anything nested deeper than MAX_REDACT_DEPTH is replaced.
 */
function redactDeep(value: unknown, redactor: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactText(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    const text = String(value);
    if (redactText(text, redactor) !== text) return REDACTION_MARKER;
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactText(key, redactor),
      isCredentialField(key) && entry !== null && entry !== undefined ? REDACTION_MARKER : redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/** The audit's tool for a call to a tool this gateway does not have. */
const UNKNOWN_TOOL = 'unknown_tool';

/** One gateway instance, as returned by createOutlineGateway. */
export type OutlineGateway = ReturnType<typeof createOutlineGateway>;

/**
 * The handler's result as the gateway returns it: its data redacted twice
 * (values, keys and numbers by their string form), and only then serialised
 * after the summary, so a secret cannot survive in an escaped form.
 */
function normalizeResult(result: unknown, redactor: SecretRedactor, summary: string): GatewayToolResult {
  const content = (result as { content?: unknown } | null)?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  let data: unknown = result;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // Our handlers always return JSON text; anything else is not passed on.
      return errorResult('The Outline gateway tool returned something that is not JSON; nothing of it is passed on.');
    }
  }
  // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
  return jsonResult(summary, redactDeep(redactDeep(data, redactor), redactor));
}

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = toGatewayJson(structuredContent);
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
  };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}

function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}
