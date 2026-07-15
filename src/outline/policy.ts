/**
 * Read tools are always on. Write tools require OUTLINE_ENABLE_WRITES=true.
 * The genuinely destructive Outline operations are deliberately NOT exposed
 * by any tool: collections.delete (cascading permanent delete of every
 * document in a collection), documents.delete with permanent:true,
 * documents.empty_trash, users.delete. Document delete here is the normal
 * soft-delete to Trash (recoverable), never permanent.
 */
export function writesEnabled(): boolean {
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

export function checkToolPolicy(toolName: string): OutlinePolicyDecision {
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
