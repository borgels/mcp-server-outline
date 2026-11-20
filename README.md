# mcp-server-outline

MCP server for the [Outline](https://www.getoutline.com/developers) knowledge base / wiki API. Works against any self-hosted or cloud Outline instance.

This is an independent, unofficial project. It is not developed, endorsed or supported by Outline.

## Tools

**Read:** `outline_search` (ranked full-text with context snippets; filter by collection/status/date/author), `outline_list_documents` (recent/drafts/archived/trash), `outline_get_document` (info or full Markdown export), `outline_list_collections`, `outline_get_collection` (+ document tree), `outline_list_comments`, `outline_list_revisions`, `outline_whoami`, `outline_search_capabilities`.

**Write (opt-in via `OUTLINE_ENABLE_WRITES=true`):** `outline_create_document`, `outline_update_document` (replace or append), `outline_move_document`, `outline_archive_document` (archive/restore), `outline_delete_document` (soft-delete to Trash only), `outline_create_comment`, `outline_manage_collection` (create/update).

**Deliberately not exposed:** `collections.delete` (cascading permanent delete of every document inside), permanent document deletion / `documents.empty_trash`, and user deletion. Document deletion is always the recoverable soft-delete.

## Auth

Bearer API token (Outline → Settings → API → Create). The token inherits its creating user's document/collection permissions — create a dedicated service user per instance with the right collection access. Tokens are per-instance.

## Configuration

See `.env.example`. Required: `OUTLINE_BASE_URL` (the server appends `/api`), `OUTLINE_API_TOKEN`. Optional: `OUTLINE_TIMEOUT_MS` (1-600000, default 30000), `OUTLINE_ENABLE_WRITES`, `OUTLINE_AUDIT_LOG`. The HTTP transport checks the Outline configuration at startup and exits if it is missing or invalid.

API method names are restricted to the `collection.method` form, so caller input is never placed in the URL path. Requests to Outline never follow redirects, so the token is not re-sent to another location. Outline's error bodies are never read: an error is our own text, starting with `Outline API request failed with HTTP <status>`.

### HTTP transport

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` (or `HOST`) | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | unset | Bearer token required on `/mcp`; at least 32 printable ASCII characters. Required when binding to a non-loopback address or with `MCP_ALLOW_ANY_ORIGIN=true`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Start without a token on a non-loopback bind anyway (only when access is restricted by other means). |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. Requests without `Origin` (server-to-server) are allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any `Origin` (requires a token). |
| `MCP_ALLOWED_HOSTS` | see meaning | Comma-separated host names accepted in the `Host` header. By default a loopback bind only accepts localhost names and its bind address; other binds do not check `Host`. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body size. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address and window before further failures get HTTP 429; `0` disables. Requests with a valid token are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |

Invalid numeric or boolean values stop the server at startup with a message
naming the variable. `GET /healthz` answers `{"status":"ok"}` without
authentication, for container health checks.

## Embedding (`./gateway`)

`mcp-server-outline/gateway` lets a host application run the tools in-process
instead of over MCP, in the same shape as `mcp-server-template`. One process
can run several gateway instances, for example one per tenant.

```ts
import { createOutlineGateway, normalizeOutlineBaseUrl, outlineToolCatalog } from 'mcp-server-outline/gateway';

// Before storing an address a customer typed: throws GatewayConfigError, or returns https://<host>.
const baseUrl = normalizeOutlineBaseUrl(input.address);

const gateway = createOutlineGateway({
  apiToken: tenant.outlineKey,
  baseUrl,
  policy: { enableWrites: true, audit: record => log(record) },
});
const result = await gateway.callTool('search_documents', { query: 'onboarding' }, { caller: 'user-1' });
```

The module exports:

- `createOutlineGateway({ apiToken, baseUrl, fetchImpl?, timeoutMs?, resolveHost?, policy? })`.
  `apiToken` is an Outline API key (sent as `Authorization: Bearer`),
  `baseUrl` the customer's Outline address: Outline Cloud
  (`https://<team>.getoutline.com`, or `https://app.getoutline.com`) or a
  self-hosted https address; the client adds `/api`. Both are required and
  never read from the environment. The gateway reads no `OUTLINE_*` variable
  at all: not `OUTLINE_API_TOKEN`, `OUTLINE_BASE_URL`,
  `OUTLINE_ENABLE_WRITES` (the host's policy decides), `OUTLINE_TIMEOUT_MS`
  (default 30 seconds) or `OUTLINE_AUDIT_LOG`. Every call runs as the user
  who owns the key, with that user's Outline permissions (and the key's
  scopes, where the key has any). Per-person rights are the host's business.
- `normalizeOutlineBaseUrl(url)`: a pure check a host can run before it
  stores an address. It returns `https://<host>` (lower case, no trailing
  slash or dot) or throws `GatewayConfigError` with a message starting
  `Outline address refused:` (`ADDRESS_REFUSED`) that never quotes the value.
  Refused: anything but `https://`, a user name or password, a port, a path,
  a query string or a fragment, an IP address, `localhost` and local or
  single-label names (`.local`, `.internal`, `.lan`, `.home.arpa`, ...).
- `gateway.tools` (the tools enabled on the instance) and
  `gateway.callTool(name, input, { caller, requestId })`. Names are accepted
  with or without the `outline_` prefix. Input is validated with the tool's
  zod schema before anything is sent, and unknown fields are refused. The
  audit records of a call hold `caller` only as an HMAC pseudonym (a
  per-process key) and a request id of the server's own; the host's
  `requestId` is not written. An error is recorded as a fixed code
  (`http_<status>`, `timeout` or `error`), never as its message.
- `outlineGatewayTools`: the definitions (`name` without prefix, `title`,
  `description`, `riskLevel`, `enabledByDefault`, `inputSchema` as JSON
  Schema derived from the zod schema the call is validated with).
- `outlineToolCatalog`: the same tools, deeply frozen, with `upstream` (method
  and path of every Outline request the tool may make) and `broad` (no
  Outline tool is broad).
- `GatewayConfigError`, `KEY_REFUSED`, `ADDRESS_REFUSED`,
  `PRIVATE_ADDRESS_REFUSED` and the types (`OutlineGatewayOptions`,
  `OutlineGateway`, `InstancePolicy`, `AuditSink`, `GatewayToolDefinition`,
  `GatewayToolCatalogEntry`, `GatewayUpstreamOperation`, `GatewayToolResult`,
  `GatewayCallContext` and the JSON types such as `GatewayJsonObject`).

Outline's API is RPC over HTTP: every request is a `POST` to
`/api/<resource>.<method>`, reads included.

| Tool | Risk | Default | Input | Outline requests (on `baseUrl`) |
|---|---|---|---|---|
| `search_capabilities` | read | on | `query?`, `limit?` | none |
| `check_connection` | read | on | none | `POST /api/auth.info` |
| `search_documents` | read | on | `query`, `collectionId?`, `limit?`, `offset?` | `POST /api/documents.search` |
| `list_documents` | read | on | `collectionId?`, `parentDocumentId?`, `limit?`, `offset?` | `POST /api/documents.list` |
| `get_document` | read | on | `id` | `POST /api/documents.info` |
| `list_collections` | read | on | `limit?`, `offset?` | `POST /api/collections.list` |
| `get_collection` | read | on | `id`, `includeStructure?` | `POST /api/collections.info`, `POST /api/collections.documents` |
| `list_comments` | read | on | `documentId`, `limit?`, `offset?` | `POST /api/comments.list` |
| `list_revisions` | read | on | `documentId`, `limit?`, `offset?` | `POST /api/revisions.list` |
| `create_document` | write | off | `collectionId`, `title`, `text?`, `parentDocumentId?`, `publish?` | `POST /api/documents.create` |
| `update_document` | write | off | `id`, `title?`, `text?`, `textMode?` | `POST /api/documents.update` |
| `create_comment` | write | off | `documentId`, `text`, `parentCommentId?` | `POST /api/comments.create` |

`check_connection` returns the user's id, name and role and the workspace's
id and name, no email address. `get_document` returns the text as Markdown;
the list tools return documents without their text, and `list_revisions`
returns who saved which title when, without the text of each version. Lists
return `{ items, offset, limit, hasMore }` (at most 100 per page). Results
hold a fixed set of fields per object: share links, policies, email
addresses, avatars and fields Outline adds later are left out.
`create_document` creates a draft unless `publish` is `true`.
`update_document` adds `text` to the end of the document unless `textMode` is
`"replace"`; Outline keeps the earlier version in the document's history.
There are no tools that delete, archive, restore or move documents, or that
create, change or share collections, and no raw API call. Each tool gets a
client view that refuses any Outline method it does not declare. The MCP
server's own tools (`outline_delete_document`, `outline_manage_collection`,
...) are unchanged.

**Address and network.** Every connection goes only to public addresses:
the host name is resolved and every address must be public unicast
(private, loopback, link-local, carrier-grade NAT, unique local, metadata
and documentation ranges, and IPv4 embedded in IPv6 are refused). With the
built-in fetch the check runs in the connection's own lookup, so the address
checked is the address used (DNS rebinding is checked per connection). With
a host `fetchImpl` the name is checked before every request. A refusal
happens at the call, not at construction, as an error result
`Refused: the Outline address points to a private or local network address.`
(`PRIVATE_ADDRESS_REFUSED`); a name that does not resolve gives
`Network error calling the Outline API (ENOTFOUND).` Redirects are never
followed, and a throttled request (HTTP 429) is not retried.

**Instance policy.** With `policy: { enableWrites, disabledTools, audit }`
the host decides the instance's policy: write tools run only with
`enableWrites: true`; disabled tools are left out of `tools` (and out of
`search_capabilities`) and refused when called; audit records go to `audit`
(none without it). `disabledTools` must name gateway tools. A sink that
throws on a start record refuses the call. Without `policy` the instance uses
the default policy (no writes, no disabled tools, no audit records). Every
call runs in a call scope of its own (AsyncLocalStorage), so a call made from
inside another instance's call never inherits its policy, sink, redactor or
caller. There is no process-wide registry of secrets.

**Results.** A successful result is a short English summary line, a blank
line and the data as compact JSON, exactly equal to `structuredContent`. The
data is redacted twice before it is serialised: credential-shaped text
(Authorization headers, Bearer and Basic values, Outline API keys, JSON Web
Tokens, credential assignments) and the value of credential-named fields are
masked, and the instance's key (exact, encoded, and any piece of 6
characters or more, in strings, keys and the string form of numbers) is
replaced by `‹redacted›`. An answer from Outline that is not JSON is refused.

**Errors.** An error result carries our own English text, never Outline's
response body or message, a redirect's `Location` or the configured address.
An HTTP failure starts with `Outline API request failed with HTTP <status>`,
followed by our own hint (400, 401, 403, 404, 429) and the parsed
`retry-after` where there is one. Other errors start with
`Invalid input for <tool>:`, `Unsupported Outline gateway tool.`,
`Outline API responded with a redirect (HTTP <status>)`,
`Network error calling the Outline API`, `Outline API request timed out after`,
`Outline answered with something that is not JSON`, `Refused: the Outline
address points to a private or local network address.`, or a policy
refusal (`writes are disabled. ...`, `tool is disabled on this instance by
the embedding host: <tool>`).

**Key admission and the sink check.** A gateway accepts only a key of
printable ASCII (0x21-0x7E) of at least 16 characters that shares no piece of
6 characters with a string literal in `src/` (`src/fixed-corpus.generated.ts`,
kept up to date by a test), with the fixed fallbacks (`src/fallbacks.ts`) or
with the tool list. No text in `src/` shares a piece with the prefix of
Outline's keys and what follows it (a test checks this), so a real Outline
key is never refused for its prefix. A refused key throws
`GatewayConfigError` at construction
(`options.apiToken: A credential was refused: ...`), before anything is built
or sent; the refusal holds no piece of the key, and every error a gateway
throws has no `cause` and a `stack` of only `name: message`. As the very last
step every output (the tool list, each result, each audit record) is checked
in its final form, and one that still holds a piece of the key is replaced by
a fixed fallback. Whether Outline accepts the key is only known at the first
call (`check_connection`: HTTP 401).

## Security model

- The server uses one shared Outline API token for every caller; it acts with
  the permissions of the user that created the token.
- `MCP_HTTP_TOKEN` is a single shared secret that authenticates callers of
  the HTTP endpoint; it does not identify individual users. Per-user
  authentication and authorization belong in an identity-aware gateway or
  proxy in front of this server.
- Access to a tool is access to every document and collection that token can
  reach. Restrict the token's user to the collections callers should see.
- The HTTP server does not terminate TLS. Run it on loopback or a private
  network, behind a TLS-terminating proxy when traffic leaves the host.

## Install

```bash
npx mcp-server-outline
```

Runs the stdio server from npm. Configure it with the environment variables in `.env.example`.

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-outline` (published from `main` after CI passes, and for `v*` tags). Containers bind to `0.0.0.0` only with `MCP_HTTP_HOST`/`HOST` set, which requires `MCP_HTTP_TOKEN`.
