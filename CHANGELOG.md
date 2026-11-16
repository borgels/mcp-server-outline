# Changelog

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
- The server reports the package version.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32, `zod` 4.6) and
  overrides for patched transitive packages.

Upgrade notes: deployments that bind to `0.0.0.0` must set `MCP_HTTP_TOKEN`
(32+ characters) or the server exits at startup. Check that numeric variables
hold plain integers.

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
