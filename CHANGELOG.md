# Changelog

## 0.3.0 (2026-11-20)

The gateway entry point (`./gateway`) in the shape of `mcp-server-template`,
for hosts that run one instance per tenant in a shared process.

### Changes

- `createOutlineGateway({ apiToken, baseUrl, fetchImpl?, timeoutMs?, resolveHost?, policy? })`:
  the API key and the customer's Outline address are required and never read
  from the environment; the gateway reads no `OUTLINE_*` variable.
- `normalizeOutlineBaseUrl(url)`: https and a public host name only (no user
  info, port, path, query or fragment, no IP address or local name). Every
  connection of a gateway goes only to public addresses, checked by DNS per
  connection (built-in fetch) or before every request (host fetch).
- Tools: reads `search_capabilities`, `check_connection`, `search_documents`,
  `list_documents`, `get_document`, `list_collections`, `get_collection`,
  `list_comments`, `list_revisions`; writes (off by default)
  `create_document` (a draft unless `publish`), `update_document` (adds text
  to the end unless `textMode: "replace"`), `create_comment`. No delete,
  archive, move, collection or sharing tools, no raw API call. Results hold a
  fixed set of fields per object (no email addresses, policies or share
  links).
- `outlineToolCatalog`: deeply frozen, with `inputSchema` from the strict zod
  schema, `upstream` and `broad`.
- Key admission (real `ol_api_` keys are accepted), host policy
  `{ enableWrites, disabledTools, audit }`, call scopes, redaction per
  instance, the sink check and sealed construction errors, as in the
  template.
- Errors are our own text: `Outline API request failed with HTTP <status>`
  with our hint and `retry-after`; Outline's error bodies are no longer read,
  also in the MCP server. Redirects, network failures and timeouts are worded
  by us and quote neither the address nor the redirect's `Location`.
- The audit records an error as a fixed code (`http_<status>`, `timeout`,
  `error`) instead of its message, also in the MCP server.
- Published to npm and the MCP Registry from tagged releases.

### Upgrade notes

- Node 22.19 or later (the gateway uses `undici` and `ipaddr.js`).
- MCP server error texts no longer include Outline's error message or the
  redirect target.

## 0.2.0 (2026-11-16)

HTTP transport hardening, upstream client hardening and dependency updates.

- The HTTP transport refuses to start on a non-loopback bind address, or with
  `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` overrides this explicitly.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- `PORT`, `MCP_MAX_BODY_BYTES`, `OUTLINE_TIMEOUT_MS` and boolean flags are
  validated at startup; invalid values stop the server instead of silently
  disabling a limit.
- Failed authentication is throttled per client address (HTTP 429 with
  `Retry-After`); valid tokens are never throttled. New variables
  `MCP_AUTH_FAILURE_LIMIT` (default 20, `0` disables) and
  `MCP_AUTH_FAILURE_WINDOW_MS` (default 60000).
- `Host` header check on loopback binds; new variable `MCP_ALLOWED_HOSTS`.
- HTTP 401 carries `WWW-Authenticate: Bearer`; invalid JSON gets HTTP 400
  (JSON-RPC parse error) instead of 500; oversized bodies get 413 before
  being read.
- New unauthenticated `GET /healthz`; graceful shutdown on SIGTERM/SIGINT.
- Requests to Outline use `redirect: 'manual'`: a redirect is reported as an
  error and the token and request body are never re-sent to another location.
- Error bodies are read up to 64 KB; upstream text in errors is redacted
  (including the configured token by value) before it is shortened, and error
  URLs no longer include the query string.
- The HTTP transport checks the Outline client configuration
  (`OUTLINE_BASE_URL`, `OUTLINE_TIMEOUT_MS`) at startup and exits if it is
  invalid.
- Images are published only after CI passes, from `main` and `v*` tags, with
  SBOM and provenance attestations.
- Tool descriptions and examples refer to Outline generically.
- The server reports the package version.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32, `zod` 4.6) and
  overrides for patched transitive packages.

Upgrade notes: deployments that bind to `0.0.0.0` must set `MCP_HTTP_TOKEN`
(32+ characters) or the server exits at startup. Check that numeric variables
hold plain integers. A server bound to a loopback address behind a reverse
proxy that forwards the public `Host` header now answers 403 on `/mcp` until
that host name is listed in `MCP_ALLOWED_HOSTS`.

## 0.1.0

Initial release.

- 16 tools against the Outline (wiki) API: ranked search with snippets, list/get
  documents (incl. markdown export, drafts/archived/trash), collections (+ structure),
  comments, revisions, whoami; write tools for create/update/move/archive/soft-delete
  documents, comments, and create/update collections.
- All-POST RPC client (/api/<resource>.<method>) with 429 Retry-After backoff and
  bounded pagination.
- Writes gated behind OUTLINE_ENABLE_WRITES. Destructive/cascading ops
  (collections.delete, permanent document delete, empty_trash, user delete) are
  deliberately NOT exposed; document delete is soft-delete to Trash only.
