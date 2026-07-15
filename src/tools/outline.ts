import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../outline/audit.js';
import { READ_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, searchCapabilities } from '../outline/capabilities.js';
import type { OutlineClient } from '../outline/client.js';
import { assertWritesEnabled, checkToolPolicy } from '../outline/policy.js';

export function registerOutlineTools(server: McpServer, client: OutlineClient): void {
  server.registerTool(
    'outline_search_capabilities',
    {
      title: 'Search Outline Capabilities',
      description: 'Search the Outline/Playbook MCP capabilities. Use first when deciding which tool to call.',
      inputSchema: { query: z.string().trim().default(''), limit: z.number().int().min(1).max(50).default(20) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('outline_search_capabilities', input, async () => json(searchCapabilities(input.query, input.limit))),
  );

  server.registerTool(
    'outline_whoami',
    {
      title: 'Who Am I (Outline)',
      description: 'Show the user + workspace this Playbook token belongs to.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('outline_whoami', input, async () => json(await client.call('auth.info'))),
  );

  server.registerTool(
    'outline_search',
    {
      title: 'Search Documents (Outline)',
      description:
        'Ranked full-text search with context snippets. Optional filters: collectionId, statusFilter (draft/published/archived), dateFilter (day/week/month/year), userId.',
      inputSchema: {
        query: z.string().trim().min(1),
        collectionId: z.string().trim().optional(),
        userId: z.string().trim().optional(),
        statusFilter: z.array(z.enum(['draft', 'published', 'archived'])).optional(),
        dateFilter: z.enum(['day', 'week', 'month', 'year']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_search', input, async () =>
        json(
          await client.call('documents.search', {
            query: input.query,
            collectionId: input.collectionId,
            userId: input.userId,
            statusFilter: input.statusFilter,
            dateFilter: input.dateFilter,
            limit: input.limit ?? 25,
            offset: input.offset ?? 0,
          }),
        ),
      ),
  );

  server.registerTool(
    'outline_list_documents',
    {
      title: 'List Documents (Outline)',
      description: 'List documents: recent (default), drafts, archived, or deleted (Trash). Optionally scope to a collection.',
      inputSchema: {
        filter: z.enum(['recent', 'drafts', 'archived', 'deleted']).default('recent'),
        collectionId: z.string().trim().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_list_documents', input, async () => {
        const method =
          input.filter === 'drafts'
            ? 'documents.drafts'
            : input.filter === 'archived'
              ? 'documents.archived'
              : input.filter === 'deleted'
                ? 'documents.deleted'
                : 'documents.list';
        return json(
          await client.listAll(method, {
            collectionId: input.collectionId,
            limit: input.limit ?? 25,
            offset: input.offset ?? 0,
          }),
        );
      }),
  );

  server.registerTool(
    'outline_get_document',
    {
      title: 'Get Document (Outline)',
      description: 'Fetch one document by id or slug. asMarkdown=true returns the full Markdown body.',
      inputSchema: {
        id: z.string().trim().min(1).describe('Document id or url slug.'),
        asMarkdown: z.boolean().default(false),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_get_document', input, async () =>
        json(await client.call(input.asMarkdown ? 'documents.export' : 'documents.info', { id: input.id })),
      ),
  );

  server.registerTool(
    'outline_list_collections',
    {
      title: 'List Collections (Outline)',
      description: 'List the collections in the workspace.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_list_collections', input, async () =>
        json(await client.listAll('collections.list', { limit: input.limit ?? 25, offset: input.offset ?? 0 })),
      ),
  );

  server.registerTool(
    'outline_get_collection',
    {
      title: 'Get Collection (Outline)',
      description: 'Fetch one collection; includeStructure=true adds its document tree.',
      inputSchema: { id: z.string().trim().min(1), includeStructure: z.boolean().default(false) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_get_collection', input, async () => {
        const info = await client.call('collections.info', { id: input.id });
        if (!input.includeStructure) {
          return json(info);
        }
        const structure = await client.call('collections.documents', { id: input.id });
        return json({ collection: info, structure });
      }),
  );

  server.registerTool(
    'outline_list_comments',
    {
      title: 'List Comments (Outline)',
      description: 'List comments on a document.',
      inputSchema: {
        documentId: z.string().trim().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_list_comments', input, async () =>
        json(await client.listAll('comments.list', { documentId: input.documentId, limit: input.limit ?? 25, offset: input.offset ?? 0 })),
      ),
  );

  server.registerTool(
    'outline_list_revisions',
    {
      title: 'List Revisions (Outline)',
      description: 'A document’s version history, or one revision with revisionId.',
      inputSchema: {
        documentId: z.string().trim().min(1),
        revisionId: z.string().trim().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_list_revisions', input, async () => {
        if (input.revisionId) {
          return json(await client.call('revisions.info', { id: input.revisionId }));
        }
        return json(await client.listAll('revisions.list', { documentId: input.documentId, limit: input.limit ?? 25, offset: input.offset ?? 0 }));
      }),
  );

  // --- writes ---

  server.registerTool(
    'outline_create_document',
    {
      title: 'Create Document (Outline)',
      description: 'Create a document (Markdown body) in a collection. publish=true makes it visible; parentDocumentId nests it. Requires write access.',
      inputSchema: {
        collectionId: z.string().trim().min(1),
        title: z.string().trim().min(1),
        text: z.string().default('').describe('Markdown body.'),
        parentDocumentId: z.string().trim().optional(),
        publish: z.boolean().default(true),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_create_document', input, async () => {
        assertWritesEnabled('outline_create_document');
        return json(await client.call('documents.create', input));
      }),
  );

  server.registerTool(
    'outline_update_document',
    {
      title: 'Update Document (Outline)',
      description: 'Update a document title/body. append=true adds text to the end; otherwise text REPLACES the whole body. Requires write access.',
      inputSchema: {
        id: z.string().trim().min(1),
        title: z.string().trim().optional(),
        text: z.string().optional(),
        append: z.boolean().default(false),
        publish: z.boolean().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_update_document', input, async () => {
        assertWritesEnabled('outline_update_document');
        return json(await client.call('documents.update', input));
      }),
  );

  server.registerTool(
    'outline_move_document',
    {
      title: 'Move Document (Outline)',
      description: 'Move a document to another collection and/or under another parent document. Requires write access.',
      inputSchema: {
        id: z.string().trim().min(1),
        collectionId: z.string().trim().optional(),
        parentDocumentId: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_move_document', input, async () => {
        assertWritesEnabled('outline_move_document');
        if (!input.collectionId && !input.parentDocumentId) {
          throw new Error('Provide collectionId and/or parentDocumentId to move to.');
        }
        return json(await client.call('documents.move', input));
      }),
  );

  server.registerTool(
    'outline_archive_document',
    {
      title: 'Archive/Restore Document (Outline)',
      description: 'Archive a document (reversible) or restore an archived/trashed one. Requires write access.',
      inputSchema: { id: z.string().trim().min(1), action: z.enum(['archive', 'restore']) },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_archive_document', input, async () => {
        assertWritesEnabled('outline_archive_document');
        return json(await client.call(input.action === 'archive' ? 'documents.archive' : 'documents.restore', { id: input.id }));
      }),
  );

  server.registerTool(
    'outline_delete_document',
    {
      title: 'Delete Document (Outline)',
      description: 'Move a document to Trash (recoverable via restore). Permanent deletion is not available here. Requires write access.',
      inputSchema: { id: z.string().trim().min(1) },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_delete_document', input, async () => {
        assertWritesEnabled('outline_delete_document');
        // Never pass permanent:true — soft-delete to Trash only.
        return json(await client.call('documents.delete', { id: input.id }));
      }),
  );

  server.registerTool(
    'outline_create_comment',
    {
      title: 'Comment on Document (Outline)',
      description: 'Add a comment to a document; parentCommentId replies to a thread. Requires write access.',
      inputSchema: {
        documentId: z.string().trim().min(1),
        text: z.string().trim().min(1),
        parentCommentId: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_create_comment', input, async () => {
        assertWritesEnabled('outline_create_comment');
        return json(await client.call('comments.create', input));
      }),
  );

  server.registerTool(
    'outline_manage_collection',
    {
      title: 'Create/Update Collection (Outline)',
      description: 'Create a new collection or update one (name/description/permission). Deleting collections is not available (cascades permanently). Requires write access.',
      inputSchema: {
        action: z.enum(['create', 'update']),
        id: z.string().trim().optional(),
        name: z.string().trim().optional(),
        description: z.string().optional(),
        permission: z.enum(['read', 'read_write']).optional(),
        color: z.string().trim().optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('outline_manage_collection', input, async () => {
        assertWritesEnabled('outline_manage_collection');
        if (input.action === 'create') {
          if (!input.name) throw new Error('name is required to create a collection.');
          return json(await client.call('collections.create', input));
        }
        if (!input.id) throw new Error('id is required to update a collection.');
        return json(await client.call('collections.update', input));
      }),
  );
}

async function run<T>(tool: string, input: unknown, call: () => Promise<T>): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);
  if (!policy.allowed) {
    await writeAuditEvent({ tool, action: 'policy_denied', target, reason: policy.reason });
    throw new Error(policy.reason);
  }
  await writeAuditEvent({ tool, action: 'start', target, reason: policy.reason });
  try {
    const result = await call();
    await writeAuditEvent({ tool, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({ tool, action: 'error', target, status: 'error', error: formatUnknownError(error) });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const v = input as Record<string, unknown>;
  return {
    id: v.id,
    documentId: v.documentId,
    collectionId: v.collectionId,
    revisionId: v.revisionId,
    parentDocumentId: v.parentDocumentId,
    action: v.action,
    filter: v.filter,
    query: v.query,
  };
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
