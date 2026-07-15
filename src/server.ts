import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OutlineClient, type OutlineClientOptions } from './outline/client.js';
import { registerOutlineTools } from './tools/outline.js';

export interface CreateServerOptions {
  client?: OutlineClient;
  clientOptions?: OutlineClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'outline', version: '0.1.0' });
  const client = options.client ?? new OutlineClient(options.clientOptions);
  registerOutlineTools(server, client);
  return server;
}
