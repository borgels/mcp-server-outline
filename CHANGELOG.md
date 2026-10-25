# Changelog

## 0.2.0

- **Per-user personal API keys.** The HTTP transport no longer uses a shared
  workspace token: each user links their own Outline API key once via
  `outline_connect`, which returns a single-use browser form (`/outline/enroll`)
  where the key is pasted — never through the chat. Keys are validated against
  `auth.info` before being stored AES-256-GCM encrypted, keyed by the
  gateway-verified identity (`X-MCP-User`). Every tool then runs with that user's
  own key, so the connector can never see more than the user already can.
- New tools: `outline_connect`, `outline_status`, `outline_disconnect`.
- `OutlineClient` takes the token per call (`client.as(token)`); `OUTLINE_API_TOKEN`
  is stdio/local only and is ignored (with a warning) in HTTP mode.
- New config: `OUTLINE_ENCRYPTION_KEY`, `OUTLINE_STORE_PATH`,
  `OUTLINE_PUBLIC_BASE_URL`, `OUTLINE_TRUST_FORWARDED_USER`.
- Audit records now carry `actingAs` (the verified caller), and `/healthz` was added.

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
