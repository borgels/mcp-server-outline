import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { GATEWAY_CAPABILITIES, READ_TOOL_ANNOTATIONS, searchCapabilities, WRITE_TOOL_ANNOTATIONS } from '../outline/capabilities.js';
import type { OutlineClient } from '../outline/client.js';
import {
  collection,
  comment,
  connection,
  dataOf,
  documentSummary,
  documentWithText,
  page,
  revision,
  searchHit,
  structure,
} from '../outline/gateway-data.js';
import { currentOfferedTools } from '../outline/scope.js';
import { json, run } from './outline.js';

/**
 * The tools of the embedded gateway (src/gateway.ts). They run as the API
 * key's own user under the host's policy. The MCP server's own tools
 * (src/tools/outline.ts) are unchanged; the gateway has narrower tools with
 * their own names, and none that deletes, archives, moves or manages
 * collections or permissions.
 *
 * Every Outline method a tool may call is listed here (GATEWAY_UPSTREAM), and
 * each tool gets a view of the client that refuses any other method.
 */
export const GATEWAY_UPSTREAM: Readonly<Record<string, readonly string[]>> = {
  search_capabilities: [],
  check_connection: ['auth.info'],
  search_documents: ['documents.search'],
  list_documents: ['documents.list'],
  get_document: ['documents.info'],
  list_collections: ['collections.list'],
  get_collection: ['collections.info', 'collections.documents'],
  list_comments: ['comments.list'],
  list_revisions: ['revisions.list'],
  create_document: ['documents.create'],
  update_document: ['documents.update'],
  create_comment: ['comments.create'],
};

/** A view of the client that calls only the Outline methods the tool declares. */
function restricted(client: OutlineClient, tool: string): OutlineClient {
  const allowed = new Set(GATEWAY_UPSTREAM[tool] ?? []);
  const call = async <T>(method: string, body: Record<string, unknown> = {}): Promise<T> => {
    if (!allowed.has(method)) {
      throw new Error(`Tool ${tool} attempted an Outline request it does not declare; refused.`);
    }
    return client.call<T>(method, body);
  };
  const listAll = async () => {
    throw new Error(`Tool ${tool} attempted an Outline request it does not declare; refused.`);
  };
  return Object.assign(Object.create(client) as OutlineClient, { call, listAll });
}

/** An Outline id: a UUID, or a document's url slug ("title-abc123"). */
const idSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9-]+$/);
const pageShape = {
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(100_000).default(0),
};

export function registerOutlineGatewayTools(server: McpServer, client: OutlineClient): void {
  const view = (tool: string) => restricted(client, tool);
  // Policy, audit and the result as JSON text, as in the MCP server's tools.
  const audited = (tool: string, input: unknown, call: () => Promise<unknown>) =>
    run(`outline_${tool}`, input, async () => json(await call()));

  server.registerTool(
    'outline_search_capabilities',
    {
      title: 'Search Outline capabilities',
      inputSchema: {
        query: z.string().trim().max(500).default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('search_capabilities', input, async () => {
        const offered = currentOfferedTools() ?? new Set<string>();
        return searchCapabilities(
          input.query,
          input.limit,
          GATEWAY_CAPABILITIES.filter(capability => offered.has(capability.id)),
        );
      }),
  );

  server.registerTool(
    'outline_check_connection',
    { title: 'Check Outline connection', inputSchema: {}, annotations: READ_TOOL_ANNOTATIONS },
    async input => audited('check_connection', input, async () => connection(await view('check_connection').call('auth.info'))),
  );

  server.registerTool(
    'outline_search_documents',
    {
      title: 'Search Outline documents',
      inputSchema: { query: z.string().trim().min(1).max(1000), collectionId: idSchema.optional(), ...pageShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('search_documents', input, async () => {
        const answer = await view('search_documents').call('documents.search', {
          query: input.query,
          ...(input.collectionId ? { collectionId: input.collectionId } : {}),
          limit: input.limit,
          offset: input.offset,
        });
        return page(answer, input.offset, input.limit, searchHit);
      }),
  );

  server.registerTool(
    'outline_list_documents',
    {
      title: 'List Outline documents',
      inputSchema: { collectionId: idSchema.optional(), parentDocumentId: idSchema.optional(), ...pageShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('list_documents', input, async () => {
        const answer = await view('list_documents').call('documents.list', {
          ...(input.collectionId ? { collectionId: input.collectionId } : {}),
          ...(input.parentDocumentId ? { parentDocumentId: input.parentDocumentId } : {}),
          sort: 'updatedAt',
          direction: 'DESC',
          limit: input.limit,
          offset: input.offset,
        });
        return page(answer, input.offset, input.limit, documentSummary);
      }),
  );

  server.registerTool(
    'outline_get_document',
    {
      title: 'Get Outline document',
      inputSchema: { id: idSchema.describe('Document id or url slug.') },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('get_document', input, async () =>
        documentWithText(dataOf(await view('get_document').call('documents.info', { id: input.id }))),
      ),
  );

  server.registerTool(
    'outline_list_collections',
    { title: 'List Outline collections', inputSchema: { ...pageShape }, annotations: READ_TOOL_ANNOTATIONS },
    async input =>
      audited('list_collections', input, async () => {
        const answer = await view('list_collections').call('collections.list', { limit: input.limit, offset: input.offset });
        return page(answer, input.offset, input.limit, collection);
      }),
  );

  server.registerTool(
    'outline_get_collection',
    {
      title: 'Get Outline collection',
      inputSchema: { id: idSchema, includeStructure: z.boolean().default(false) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('get_collection', input, async () => {
        const outline = view('get_collection');
        const info = collection(dataOf(await outline.call('collections.info', { id: input.id })));
        if (!input.includeStructure) {
          return info;
        }
        return { ...info, structure: structure(dataOf(await outline.call('collections.documents', { id: input.id }))) };
      }),
  );

  server.registerTool(
    'outline_list_comments',
    {
      title: 'List Outline comments',
      inputSchema: { documentId: idSchema, ...pageShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('list_comments', input, async () => {
        const answer = await view('list_comments').call('comments.list', {
          documentId: input.documentId,
          limit: input.limit,
          offset: input.offset,
        });
        return page(answer, input.offset, input.limit, comment);
      }),
  );

  server.registerTool(
    'outline_list_revisions',
    {
      title: 'List Outline revisions',
      inputSchema: { documentId: idSchema, ...pageShape },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('list_revisions', input, async () => {
        const answer = await view('list_revisions').call('revisions.list', {
          documentId: input.documentId,
          limit: input.limit,
          offset: input.offset,
        });
        return page(answer, input.offset, input.limit, revision);
      }),
  );

  server.registerTool(
    'outline_create_document',
    {
      title: 'Create Outline document',
      inputSchema: {
        collectionId: idSchema,
        title: z.string().trim().min(1).max(255),
        text: z.string().max(500_000).default('').describe('Markdown.'),
        parentDocumentId: idSchema.optional(),
        publish: z.boolean().default(false),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('create_document', input, async () =>
        documentSummary(
          dataOf(
            await view('create_document').call('documents.create', {
              collectionId: input.collectionId,
              title: input.title,
              text: input.text,
              ...(input.parentDocumentId ? { parentDocumentId: input.parentDocumentId } : {}),
              publish: input.publish,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    'outline_update_document',
    {
      title: 'Update Outline document',
      inputSchema: {
        id: idSchema.describe('Document id or url slug.'),
        title: z.string().trim().min(1).max(255).optional(),
        text: z.string().min(1).max(500_000).optional().describe('Markdown.'),
        textMode: z.enum(['append', 'replace']).default('append'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('update_document', input, async () => {
        if (input.title === undefined && input.text === undefined) {
          throw new Error('Give title, text or both to update the document.');
        }
        return documentSummary(
          dataOf(
            await view('update_document').call('documents.update', {
              id: input.id,
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.text !== undefined ? { text: input.text, append: input.textMode === 'append' } : {}),
            }),
          ),
        );
      }),
  );

  server.registerTool(
    'outline_create_comment',
    {
      title: 'Comment on Outline document',
      inputSchema: {
        documentId: idSchema,
        text: z.string().trim().min(1).max(10_000).describe('Markdown.'),
        parentCommentId: idSchema.optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      audited('create_comment', input, async () =>
        comment(
          dataOf(
            await view('create_comment').call('comments.create', {
              documentId: input.documentId,
              text: input.text,
              ...(input.parentCommentId ? { parentCommentId: input.parentCommentId } : {}),
            }),
          ),
        ),
      ),
  );
}
