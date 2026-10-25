# mcp-server-outline

MCP server for the [Outline](https://www.getoutline.com/developers) knowledge base / wiki API. Works against any self-hosted or cloud Outline instance (we run it against our "Playbook" instances).

## Tools

**Enrollment:** `outline_connect` (link your own API key), `outline_status`, `outline_disconnect`.

**Read:** `outline_search` (ranked full-text with context snippets; filter by collection/status/date/author), `outline_list_documents` (recent/drafts/archived/trash), `outline_get_document` (info or full Markdown export), `outline_list_collections`, `outline_get_collection` (+ document tree), `outline_list_comments`, `outline_list_revisions`, `outline_whoami`, `outline_search_capabilities`.

**Write (opt-in via `OUTLINE_ENABLE_WRITES=true`):** `outline_create_document`, `outline_update_document` (replace or append), `outline_move_document`, `outline_archive_document` (archive/restore), `outline_delete_document` (soft-delete to Trash only), `outline_create_comment`, `outline_manage_collection` (create/update).

**Deliberately not exposed:** `collections.delete` (cascading permanent delete of every document inside), permanent document deletion / `documents.empty_trash`, and user deletion. Document deletion is always the recoverable soft-delete.

## Auth — personal keys, per user

Outline API tokens are personal: a token inherits exactly its creating user's document/collection permissions. This server leans on that instead of holding a workspace-wide service token.

Hosted (HTTP) mode, behind a gateway that forwards the signed-in user as `X-MCP-User`: each user runs `outline_connect` once, gets a single-use link to `/outline/enroll` (valid 10 minutes, bound to them), and pastes their own key into that browser form — the key never goes through Claude. It is validated against `auth.info`, then stored AES-256-GCM encrypted and keyed by the verified identity. Every later call uses that user's own key; a user without a linked key reaches nothing, and there is no shared fallback. `OUTLINE_API_TOKEN` is ignored in HTTP mode.

Stdio/local mode is single-user: the one token in `OUTLINE_API_TOKEN` is used directly.

## Configuration

See `.env.example`. Required everywhere: `OUTLINE_BASE_URL` (the server appends `/api`). Hosted mode also needs `OUTLINE_ENCRYPTION_KEY`, `OUTLINE_PUBLIC_BASE_URL` (used to build the enrollment link) and `OUTLINE_TRUST_FORWARDED_USER=true`; route `/outline/*` to the container directly, bypassing the gateway's own auth.

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000 — /mcp (stateless) + /outline/enroll
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-outline` (published on push to `main`).
