# Changelog

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
