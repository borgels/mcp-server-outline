export type CapabilityRisk = 'read' | 'write';

export interface OutlineCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const OUTLINE_CAPABILITIES: OutlineCapability[] = [
  {
    id: 'outline_search_capabilities',
    title: 'Search Outline Capabilities',
    description: 'Find the Outline MCP tool for searching, reading, or editing wiki documents.',
    risk: 'read',
    examples: [{ query: 'find document' }],
    identifierFormats: ['Tool id such as outline_search or outline_create_document.'],
    safetyNotes: ['Discovery only.'],
    keywords: ['discover', 'help', 'capabilities'],
  },
  {
    id: 'outline_whoami',
    title: 'Who Am I (Outline)',
    description: 'Show the user and workspace this Outline token belongs to.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: ['The token inherits this user’s document/collection permissions.'],
    keywords: ['me', 'workspace', 'team', 'hvem'],
  },
  {
    id: 'outline_search',
    title: 'Search Documents (Outline)',
    description:
      'Ranked full-text search across the wiki with highlighted context snippets. Filter by collection, author, status (draft/published/archived), and date window (day/week/month/year).',
    risk: 'read',
    examples: [{ query: 'onboarding checklist' }, { query: 'vpn', collectionId: '…', statusFilter: ['published'] }],
    identifierFormats: ['statusFilter: draft | published | archived', 'dateFilter: day | week | month | year'],
    safetyNotes: ['Only returns documents the token’s user can access.'],
    keywords: ['search', 'søg', 'find', 'wiki', 'dokument'],
  },
  {
    id: 'outline_list_documents',
    title: 'List Documents (Outline)',
    description: 'List documents: recent, drafts, archived, deleted (Trash), or viewed. Paginated.',
    risk: 'read',
    examples: [{ filter: 'recent' }, { filter: 'drafts' }, { collectionId: '…' }],
    identifierFormats: ['filter: recent | drafts | archived | deleted'],
    safetyNotes: [],
    keywords: ['documents', 'dokumenter', 'liste', 'recent', 'kladder', 'papirkurv'],
  },
  {
    id: 'outline_get_document',
    title: 'Get Document (Outline)',
    description: 'Fetch one document by id or url slug. With asMarkdown=true, returns the full Markdown body (documents.export).',
    risk: 'read',
    examples: [{ id: 'doc-id' }, { id: 'doc-id', asMarkdown: true }],
    identifierFormats: ['document id or urlId/slug'],
    safetyNotes: [],
    keywords: ['read', 'læs', 'document', 'markdown', 'export', 'indhold'],
  },
  {
    id: 'outline_list_collections',
    title: 'List Collections (Outline)',
    description: 'List the collections (top-level knowledge areas) in the workspace.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [],
    keywords: ['collections', 'samlinger', 'områder', 'kategorier'],
  },
  {
    id: 'outline_get_collection',
    title: 'Get Collection (Outline)',
    description: 'Fetch one collection, optionally with its document tree (structure) via includeStructure=true.',
    risk: 'read',
    examples: [{ id: 'col-id', includeStructure: true }],
    identifierFormats: ['collection id'],
    safetyNotes: [],
    keywords: ['collection', 'struktur', 'indholdsfortegnelse', 'tree'],
  },
  {
    id: 'outline_list_comments',
    title: 'List Comments (Outline)',
    description: 'List comments (threaded) on a document.',
    risk: 'read',
    examples: [{ documentId: 'doc-id' }],
    identifierFormats: ['documentId'],
    safetyNotes: [],
    keywords: ['comments', 'kommentarer', 'feedback'],
  },
  {
    id: 'outline_list_revisions',
    title: 'List Revisions (Outline)',
    description: 'List a document’s version history, or fetch one revision with revisionId.',
    risk: 'read',
    examples: [{ documentId: 'doc-id' }],
    identifierFormats: ['documentId', 'revisionId (optional)'],
    safetyNotes: [],
    keywords: ['revisions', 'versioner', 'historik', 'history'],
  },
  {
    id: 'outline_create_document',
    title: 'Create Document (Outline)',
    description:
      'Create a document in a collection (Markdown body). publish=true makes it visible; parentDocumentId nests it. Requires write access.',
    risk: 'write',
    examples: [{ collectionId: 'col-id', title: 'Ny vejledning', text: '# Overskrift\\n\\nIndhold…', publish: true }],
    identifierFormats: ['text is Markdown'],
    safetyNotes: ['Requires OUTLINE_ENABLE_WRITES=true.'],
    keywords: ['create', 'opret', 'ny side', 'skriv', 'document'],
  },
  {
    id: 'outline_update_document',
    title: 'Update Document (Outline)',
    description:
      'Update a document’s title and/or body. append=true adds text to the end instead of replacing. Requires write access.',
    risk: 'write',
    examples: [{ id: 'doc-id', text: 'Ny tekst' }, { id: 'doc-id', text: '\\n## Tilføjelse', append: true }],
    identifierFormats: [],
    safetyNotes: ['Requires OUTLINE_ENABLE_WRITES=true. Without append, text REPLACES the whole body.'],
    keywords: ['update', 'ret', 'rediger', 'edit', 'append'],
  },
  {
    id: 'outline_move_document',
    title: 'Move Document (Outline)',
    description: 'Move a document to another collection and/or under another parent document. Requires write access.',
    risk: 'write',
    examples: [{ id: 'doc-id', collectionId: 'other-col' }],
    identifierFormats: [],
    safetyNotes: ['Requires OUTLINE_ENABLE_WRITES=true.'],
    keywords: ['move', 'flyt', 'omorganiser'],
  },
  {
    id: 'outline_archive_document',
    title: 'Archive/Restore Document (Outline)',
    description: 'Archive a document (reversible) or restore an archived/trashed one. Requires write access.',
    risk: 'write',
    examples: [{ id: 'doc-id', action: 'archive' }, { id: 'doc-id', action: 'restore' }],
    identifierFormats: ['action: archive | restore'],
    safetyNotes: ['Requires OUTLINE_ENABLE_WRITES=true. Reversible.'],
    keywords: ['archive', 'arkivér', 'restore', 'gendan'],
  },
  {
    id: 'outline_delete_document',
    title: 'Delete Document (Outline)',
    description:
      'Move a document to Trash (recoverable for ~30 days via restore). Permanent deletion is deliberately NOT available through this server. Requires write access.',
    risk: 'write',
    examples: [{ id: 'doc-id' }],
    identifierFormats: [],
    safetyNotes: ['Requires OUTLINE_ENABLE_WRITES=true. Soft-delete to Trash only — never permanent.'],
    keywords: ['delete', 'slet', 'papirkurv', 'trash'],
  },
  {
    id: 'outline_create_comment',
    title: 'Comment on Document (Outline)',
    description: 'Add a comment to a document (optionally reply to a parent comment). Requires write access.',
    risk: 'write',
    examples: [{ documentId: 'doc-id', text: 'Ser godt ud 👍' }],
    identifierFormats: ['parentCommentId (optional, for replies)'],
    safetyNotes: ['Requires OUTLINE_ENABLE_WRITES=true.'],
    keywords: ['comment', 'kommentér', 'svar', 'feedback'],
  },
  {
    id: 'outline_manage_collection',
    title: 'Create/Update Collection (Outline)',
    description:
      'Create a new collection or update an existing one’s name/description/permission. Deleting collections is NOT available (it would permanently delete every document inside). Requires write access.',
    risk: 'write',
    examples: [{ action: 'create', name: 'HR' }, { action: 'update', id: 'col-id', description: 'Opdateret' }],
    identifierFormats: ['action: create | update'],
    safetyNotes: ['Requires OUTLINE_ENABLE_WRITES=true. No delete — collection delete cascades permanently.'],
    keywords: ['collection', 'opret område', 'samling', 'rediger'],
  },
];

/**
 * The embedded gateway's tools (src/gateway.ts). They have their own names
 * and inputs; delete, archive, move and collection management are not among
 * them.
 */
export const GATEWAY_CAPABILITIES: OutlineCapability[] = [
  {
    id: 'outline_search_capabilities',
    title: 'Search Outline capabilities',
    description: 'Find the Outline tool for searching, reading or writing wiki documents and comments.',
    risk: 'read',
    examples: [{ query: 'find document' }],
    identifierFormats: ['Tool id such as outline_search_documents or outline_create_document.'],
    safetyNotes: ['Discovery only.'],
    keywords: ['discover', 'help', 'capabilities'],
  },
  {
    id: 'outline_check_connection',
    title: 'Check Outline connection',
    description: 'Verify that Outline accepts the API key, and show the name of the user and the workspace it belongs to.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: ['Every call runs as the Outline user who owns the API key, with that user’s permissions.'],
    keywords: ['connection', 'forbindelse', 'whoami', 'me', 'workspace', 'hvem'],
  },
  {
    id: 'outline_search_documents',
    title: 'Search Outline documents',
    description: 'Full-text search in the documents the user can read, with a context snippet per hit. Optionally within one collection.',
    risk: 'read',
    examples: [{ query: 'onboarding checklist' }, { query: 'vpn', collectionId: 'collection-id' }],
    identifierFormats: ['collectionId (optional)'],
    safetyNotes: ['Only documents the API key’s user can read.'],
    keywords: ['search', 'søg', 'find', 'wiki', 'dokument'],
  },
  {
    id: 'outline_list_documents',
    title: 'List Outline documents',
    description: 'List published documents, newest first, optionally in one collection or under one parent document.',
    risk: 'read',
    examples: [{}, { collectionId: 'collection-id' }, { parentDocumentId: 'document-id' }],
    identifierFormats: ['collectionId or parentDocumentId (optional)'],
    safetyNotes: [],
    keywords: ['documents', 'dokumenter', 'liste', 'recent', 'sider'],
  },
  {
    id: 'outline_get_document',
    title: 'Get Outline document',
    description: 'Fetch one document with its text as Markdown.',
    risk: 'read',
    examples: [{ id: 'document-id' }],
    identifierFormats: ['document id or url slug'],
    safetyNotes: [],
    keywords: ['read', 'læs', 'document', 'markdown', 'indhold'],
  },
  {
    id: 'outline_list_collections',
    title: 'List Outline collections',
    description: 'List the collections (top-level knowledge areas) the user can see.',
    risk: 'read',
    examples: [{}],
    identifierFormats: [],
    safetyNotes: [],
    keywords: ['collections', 'samlinger', 'områder', 'kategorier'],
  },
  {
    id: 'outline_get_collection',
    title: 'Get Outline collection',
    description: 'Fetch one collection, optionally with its tree of document titles.',
    risk: 'read',
    examples: [{ id: 'collection-id', includeStructure: true }],
    identifierFormats: ['collection id'],
    safetyNotes: [],
    keywords: ['collection', 'struktur', 'indholdsfortegnelse', 'tree'],
  },
  {
    id: 'outline_list_comments',
    title: 'List Outline comments',
    description: 'List the comments on one document, as plain text.',
    risk: 'read',
    examples: [{ documentId: 'document-id' }],
    identifierFormats: ['documentId'],
    safetyNotes: [],
    keywords: ['comments', 'kommentarer', 'feedback'],
  },
  {
    id: 'outline_list_revisions',
    title: 'List Outline revisions',
    description: 'List the version history of one document: who changed it and when, without the text of each version.',
    risk: 'read',
    examples: [{ documentId: 'document-id' }],
    identifierFormats: ['documentId'],
    safetyNotes: [],
    keywords: ['revisions', 'versioner', 'historik', 'history'],
  },
  {
    id: 'outline_create_document',
    title: 'Create Outline document',
    description: 'Create a document with a title and a Markdown text in a collection, optionally under a parent document. A draft unless publish is true.',
    risk: 'write',
    examples: [{ collectionId: 'collection-id', title: 'Ny vejledning', text: '# Overskrift\n\nIndhold', publish: true }],
    identifierFormats: ['text is Markdown'],
    safetyNotes: ['A published document is visible to everyone who can read the collection.'],
    keywords: ['create', 'opret', 'ny side', 'skriv', 'document'],
  },
  {
    id: 'outline_update_document',
    title: 'Update Outline document',
    description: 'Change a document’s title, or add text to its end; textMode "replace" replaces the whole text.',
    risk: 'write',
    examples: [{ id: 'document-id', text: '\n## Tilføjelse' }, { id: 'document-id', text: 'Ny tekst', textMode: 'replace' }],
    identifierFormats: ['textMode: append (default) | replace'],
    safetyNotes: ['With textMode "replace" the whole text is replaced; Outline keeps the earlier version in the history.'],
    keywords: ['update', 'ret', 'rediger', 'edit', 'append', 'tilføj'],
  },
  {
    id: 'outline_create_comment',
    title: 'Comment on Outline document',
    description: 'Add a comment to a document, or reply to a comment with parentCommentId.',
    risk: 'write',
    examples: [{ documentId: 'document-id', text: 'Ser godt ud' }],
    identifierFormats: ['parentCommentId (optional, for replies)'],
    safetyNotes: ['Colleagues who can read the document see the comment.'],
    keywords: ['comment', 'kommentér', 'svar', 'feedback'],
  },
];

export function searchCapabilities(
  query: string,
  limit = 20,
  pool: readonly OutlineCapability[] = OUTLINE_CAPABILITIES,
): OutlineCapability[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return pool.slice(0, limit);
  }
  return pool.map(capability => ({ capability, score: scoreCapability(capability, normalized) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: OutlineCapability, query: string): number {
  const haystack = [capability.id, capability.title, capability.description, ...capability.identifierFormats, ...capability.keywords]
    .join(' ')
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
