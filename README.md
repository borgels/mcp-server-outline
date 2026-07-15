# mcp-server-outline

MCP server for the [Outline](https://www.getoutline.com/developers) knowledge base / wiki API. Works against any self-hosted or cloud Outline instance (we run it against our "Playbook" instances).

## Tools

**Read:** `outline_search` (ranked full-text with context snippets; filter by collection/status/date/author), `outline_list_documents` (recent/drafts/archived/trash), `outline_get_document` (info or full Markdown export), `outline_list_collections`, `outline_get_collection` (+ document tree), `outline_list_comments`, `outline_list_revisions`, `outline_whoami`, `outline_search_capabilities`.

**Write (opt-in via `OUTLINE_ENABLE_WRITES=true`):** `outline_create_document`, `outline_update_document` (replace or append), `outline_move_document`, `outline_archive_document` (archive/restore), `outline_delete_document` (soft-delete to Trash only), `outline_create_comment`, `outline_manage_collection` (create/update).

**Deliberately not exposed:** `collections.delete` (cascading permanent delete of every document inside), permanent document deletion / `documents.empty_trash`, and user deletion. Document deletion is always the recoverable soft-delete.

## Auth

Bearer API token (Outline → Settings → API → Create). The token inherits its creating user's document/collection permissions — create a dedicated service user per instance with the right collection access. Tokens are per-instance.

## Configuration

See `.env.example`. Required: `OUTLINE_BASE_URL` (the server appends `/api`), `OUTLINE_API_TOKEN`.

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-outline` (published on push to `main`).
