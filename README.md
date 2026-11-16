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

API method names are restricted to the `collection.method` form, so caller input is never placed in the URL path. Requests to Outline never follow redirects, so the token is not re-sent to another location; error bodies are read up to 64 KB and shortened after redaction.

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

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-outline` (published from `main` after CI passes, and for `v*` tags). Containers bind to `0.0.0.0` only with `MCP_HTTP_HOST`/`HOST` set, which requires `MCP_HTTP_TOKEN`.
