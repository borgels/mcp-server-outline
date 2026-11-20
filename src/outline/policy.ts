import { currentInstancePolicy } from './scope.js';

/**
 * Read tools are always on. Write tools require OUTLINE_ENABLE_WRITES=true.
 * The genuinely destructive Outline operations are deliberately NOT exposed
 * by any tool: collections.delete (cascading permanent delete of every
 * document in a collection), documents.delete with permanent:true,
 * documents.empty_trash, users.delete. Document delete here is the normal
 * soft-delete to Trash (recoverable), never permanent.
 *
 * Inside an embedded gateway call (always under an InstancePolicy,
 * src/outline/scope.ts) no environment variable is read: the host's policy
 * decides, and the gateway has neither delete, archive nor collection tools.
 */
export function writesEnabled(): boolean {
  const hosted = currentInstancePolicy();
  if (hosted) {
    return hosted.enableWrites;
  }
  return process.env.OUTLINE_ENABLE_WRITES === 'true';
}

export function assertWritesEnabled(action: string): void {
  if (!writesEnabled()) {
    throw new Error(
      `Write access is disabled on this Outline MCP instance (${action}). ` +
        'Set OUTLINE_ENABLE_WRITES=true in the server environment to allow write tools.',
    );
  }
}

export interface OutlinePolicyDecision {
  allowed: boolean;
  reason: string;
}

const READ_TOOLS = new Set([
  'outline_search_capabilities',
  'outline_whoami',
  'outline_search',
  'outline_list_documents',
  'outline_get_document',
  'outline_list_collections',
  'outline_get_collection',
  'outline_list_comments',
  'outline_list_revisions',
]);

const WRITE_TOOLS = new Set([
  'outline_create_document',
  'outline_update_document',
  'outline_move_document',
  'outline_archive_document',
  'outline_delete_document',
  'outline_create_comment',
  'outline_manage_collection',
]);

/** The embedded gateway's tools (prefixed names), and which of them change data in Outline. */
export const GATEWAY_READ_TOOLS: ReadonlySet<string> = new Set([
  'outline_search_capabilities',
  'outline_check_connection',
  'outline_search_documents',
  'outline_list_documents',
  'outline_get_document',
  'outline_list_collections',
  'outline_get_collection',
  'outline_list_comments',
  'outline_list_revisions',
]);

export const GATEWAY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'outline_create_document',
  'outline_update_document',
  'outline_create_comment',
]);

/**
 * Inside a gateway call no environment variable is read: a tool the host
 * disabled is refused, and a write tool runs only when the host enabled
 * writes.
 */
function checkHostedToolPolicy(toolName: string): OutlinePolicyDecision {
  const hosted = currentInstancePolicy()!;
  if (hosted.disabledTools.has(toolName)) {
    return { allowed: false, reason: `tool is disabled on this instance by the embedding host: ${toolName}` };
  }
  if (GATEWAY_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read tool' };
  }
  if (GATEWAY_WRITE_TOOLS.has(toolName)) {
    return hosted.enableWrites
      ? { allowed: true, reason: 'writes enabled by the embedding host' }
      : { allowed: false, reason: 'writes are disabled. The embedding host has not enabled writes for this instance.' };
  }
  return { allowed: false, reason: 'tool is not a gateway tool.' };
}

export function checkToolPolicy(toolName: string): OutlinePolicyDecision {
  if (currentInstancePolicy()) {
    return checkHostedToolPolicy(toolName);
  }
  if (READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Outline tool' };
  }
  if (WRITE_TOOLS.has(toolName)) {
    if (!writesEnabled()) {
      return {
        allowed: false,
        reason: `write tool is disabled on this instance (OUTLINE_ENABLE_WRITES != true): ${toolName}`,
      };
    }
    return { allowed: true, reason: 'write tool (writes enabled on this instance)' };
  }
  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
