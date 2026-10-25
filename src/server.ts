import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OutlineClient, type OutlineClientOptions } from './outline/client.js';
import type { KeyStore } from './outline/store.js';
import { registerOutlineTools } from './tools/outline.js';

export interface CreateServerOptions {
  client?: OutlineClient;
  clientOptions?: OutlineClientOptions;
  /**
   * Per-user API-key store. Present in hosted mode: every tool then runs with the
   * calling user's own personal Outline key and nothing else. Omitted for stdio,
   * where the single local user's OUTLINE_API_TOKEN is used.
   */
  store?: KeyStore;
  /** Gateway-verified end-user identity (X-MCP-User). */
  onBehalfOf?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'outline', version: '0.2.0' });
  const client = options.client ?? new OutlineClient(options.clientOptions);
  registerOutlineTools(server, client, { store: options.store, onBehalfOf: options.onBehalfOf });
  return server;
}
