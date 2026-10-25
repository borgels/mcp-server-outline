import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../outline/audit.js';
import { READ_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, searchCapabilities } from '../outline/capabilities.js';
import type { OutlineApi, OutlineClient } from '../outline/client.js';
import { assertWritesEnabled, checkToolPolicy, requireUser } from '../outline/policy.js';
import type { KeyStore } from '../outline/store.js';

export interface RegisterOptions {
  /** Per-user key store — present in hosted (per-user API key) mode; absent for stdio/env-token mode. */
  store?: KeyStore;
  /** Gateway-verified end-user identity (X-MCP-User). */
  onBehalfOf?: string;
}

interface ToolContext extends RegisterOptions {
  client: OutlineClient;
}

export function registerOutlineTools(server: McpServer, client: OutlineClient, options: RegisterOptions = {}): void {
  const ctx: ToolContext = { client, ...options };

  server.registerTool(
    'outline_search_capabilities',
    {
      title: 'Search Outline Capabilities',
      description: 'Search the Outline/Playbook MCP capabilities. Use first when deciding which tool to call.',
      inputSchema: { query: z.string().trim().default(''), limit: z.number().int().min(1).max(50).default(20) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => runPlain('outline_search_capabilities', input, ctx, async () => json(searchCapabilities(input.query, input.limit))),
  );

  // --- enrollment: each user links their OWN personal Outline API key ---

  server.registerTool(
    'outline_connect',
    {
      title: 'Connect your Playbook account',
      description:
        'Link YOUR personal Playbook (Outline) API key. Returns a one-time browser link where you paste the key — never paste it into the chat. Create the key in Playbook → Settings → API. Needed once; the key only ever gives what you can already see.',
      inputSchema: {},
      annotations: { ...WRITE_TOOL_ANNOTATIONS, openWorldHint: false },
    },
    async input =>
      runPlain('outline_connect', input, ctx, async () => {
        const store = requireStore(ctx);
        const user = requireUser(ctx.onBehalfOf);
        const already = store.getKeyInfo(user);
        const state = store.createState(user);
        return json({
          alreadyConnected: Boolean(already),
          enrollmentUrl: `${enrollmentBaseUrl()}/outline/enroll?state=${state}`,
          instructions:
            'Open enrollmentUrl in your browser and paste YOUR own Playbook API key (Playbook → Settings → API → New API key). The link is single-use and expires in 10 minutes. The key is stored encrypted and bound to you.',
        });
      }),
  );

  server.registerTool(
    'outline_status',
    {
      title: 'Playbook Connection Status',
      description: 'Whether your personal Playbook API key is linked here, and which Outline user it resolves to. Never returns the key.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runPlain('outline_status', input, ctx, async () => {
        const store = requireStore(ctx);
        const info = store.getKeyInfo(requireUser(ctx.onBehalfOf));
        if (!info) {
          return json({ connected: false, hint: 'Run outline_connect to link your personal API key.' });
        }
        return json({
          connected: true,
          outlineUserName: info.outlineUserName,
          outlineEmail: info.outlineEmail,
          workspaceName: info.workspaceName,
          connectedAt: new Date(info.connectedAt).toISOString(),
        });
      }),
  );

  server.registerTool(
    'outline_disconnect',
    {
      title: 'Disconnect Playbook',
      description: 'Remove your stored Playbook API key from this server. Revoke the key itself in Playbook → Settings → API.',
      inputSchema: {},
      annotations: { ...WRITE_TOOL_ANNOTATIONS, destructiveHint: true, openWorldHint: false },
    },
    async input =>
      runPlain('outline_disconnect', input, ctx, async () => {
        const store = requireStore(ctx);
        return json({ disconnected: store.deleteKey(requireUser(ctx.onBehalfOf)) });
      }),
  );

  server.registerTool(
    'outline_whoami',
    {
      title: 'Who Am I (Outline)',
      description: 'Show the user + workspace this Playbook token belongs to.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('outline_whoami', input, ctx, async api => json(await api.call('auth.info'))),
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
      run('outline_search', input, ctx, async api =>
        json(
          await api.call('documents.search', {
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
      run('outline_list_documents', input, ctx, async api => {
        const method =
          input.filter === 'drafts'
            ? 'documents.drafts'
            : input.filter === 'archived'
              ? 'documents.archived'
              : input.filter === 'deleted'
                ? 'documents.deleted'
                : 'documents.list';
        return json(
          await api.listAll(method, {
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
      run('outline_get_document', input, ctx, async api =>
        json(await api.call(input.asMarkdown ? 'documents.export' : 'documents.info', { id: input.id })),
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
      run('outline_list_collections', input, ctx, async api =>
        json(await api.listAll('collections.list', { limit: input.limit ?? 25, offset: input.offset ?? 0 })),
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
      run('outline_get_collection', input, ctx, async api => {
        const info = await api.call('collections.info', { id: input.id });
        if (!input.includeStructure) {
          return json(info);
        }
        const structure = await api.call('collections.documents', { id: input.id });
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
      run('outline_list_comments', input, ctx, async api =>
        json(await api.listAll('comments.list', { documentId: input.documentId, limit: input.limit ?? 25, offset: input.offset ?? 0 })),
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
      run('outline_list_revisions', input, ctx, async api => {
        if (input.revisionId) {
          return json(await api.call('revisions.info', { id: input.revisionId }));
        }
        return json(await api.listAll('revisions.list', { documentId: input.documentId, limit: input.limit ?? 25, offset: input.offset ?? 0 }));
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
      run('outline_create_document', input, ctx, async api => {
        assertWritesEnabled('outline_create_document');
        return json(await api.call('documents.create', input));
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
      run('outline_update_document', input, ctx, async api => {
        assertWritesEnabled('outline_update_document');
        return json(await api.call('documents.update', input));
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
      run('outline_move_document', input, ctx, async api => {
        assertWritesEnabled('outline_move_document');
        if (!input.collectionId && !input.parentDocumentId) {
          throw new Error('Provide collectionId and/or parentDocumentId to move to.');
        }
        return json(await api.call('documents.move', input));
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
      run('outline_archive_document', input, ctx, async api => {
        assertWritesEnabled('outline_archive_document');
        return json(await api.call(input.action === 'archive' ? 'documents.archive' : 'documents.restore', { id: input.id }));
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
      run('outline_delete_document', input, ctx, async api => {
        assertWritesEnabled('outline_delete_document');
        // Never pass permanent:true — soft-delete to Trash only.
        return json(await api.call('documents.delete', { id: input.id }));
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
      run('outline_create_comment', input, ctx, async api => {
        assertWritesEnabled('outline_create_comment');
        return json(await api.call('comments.create', input));
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
      run('outline_manage_collection', input, ctx, async api => {
        assertWritesEnabled('outline_manage_collection');
        if (input.action === 'create') {
          if (!input.name) throw new Error('name is required to create a collection.');
          return json(await api.call('collections.create', input));
        }
        if (!input.id) throw new Error('id is required to update a collection.');
        return json(await api.call('collections.update', input));
      }),
  );
}

function requireStore(ctx: ToolContext): KeyStore {
  if (!ctx.store) {
    throw new Error('This Outline MCP instance uses a server-configured token; there is no per-user key to connect.');
  }
  return ctx.store;
}

/** Public origin of this instance — where the browser reaches /outline/enroll. */
function enrollmentBaseUrl(): string {
  const base = process.env.OUTLINE_PUBLIC_BASE_URL;
  if (!base) {
    throw new Error('Missing OUTLINE_PUBLIC_BASE_URL — the server does not know its own public URL for the enrollment link.');
  }
  return base.replace(/\/+$/, '');
}

/**
 * Resolve the Outline client for this call. In hosted mode that is the caller's
 * own personal API key from the encrypted store — there is no shared fallback,
 * so an unenrolled user simply cannot read anything.
 */
function resolveApi(ctx: ToolContext): OutlineApi {
  if (!ctx.store) {
    return ctx.client; // stdio/local: single-user, token from OUTLINE_API_TOKEN
  }
  const user = requireUser(ctx.onBehalfOf);
  const record = ctx.store.getKey(user);
  if (!record) {
    throw new Error(
      'Your personal Playbook API key is not linked yet. Run outline_connect and paste your key in the browser form it returns.',
    );
  }
  return ctx.client.as(record.apiToken);
}

/** Tools that talk to Outline: policy + audit, called with the caller's own client. */
async function run<T>(tool: string, input: unknown, ctx: ToolContext, call: (api: OutlineApi) => Promise<T>): Promise<T> {
  return audited(tool, input, ctx, () => call(resolveApi(ctx)));
}

/** Tools that touch no Outline content (discovery, enrollment): no key needed. */
async function runPlain<T>(tool: string, input: unknown, ctx: ToolContext, call: () => Promise<T>): Promise<T> {
  return audited(tool, input, ctx, call);
}

async function audited<T>(tool: string, input: unknown, ctx: ToolContext, call: () => Promise<T>): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);
  const actingAs = ctx.onBehalfOf;
  if (!policy.allowed) {
    await writeAuditEvent({ tool, actingAs, action: 'policy_denied', target, reason: policy.reason });
    throw new Error(policy.reason);
  }
  await writeAuditEvent({ tool, actingAs, action: 'start', target, reason: policy.reason });
  try {
    const result = await call();
    await writeAuditEvent({ tool, actingAs, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({ tool, actingAs, action: 'error', target, status: 'error', error: formatUnknownError(error) });
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
