import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OutlineClient } from '../src/outline/client.js';
import { createServer } from '../src/server.js';
import { checkToolPolicy } from '../src/outline/policy.js';
import { OUTLINE_CAPABILITIES } from '../src/outline/capabilities.js';

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

interface Rec {
  url: string;
  body?: unknown;
}

function makeClient(rec: Rec[], responder?: (method: string) => unknown): OutlineClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    rec.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const method = url.split('/api/')[1] ?? '';
    return new Response(JSON.stringify(responder ? responder(method) : { data: [], pagination: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return new OutlineClient({ apiToken: 'tok', baseUrl: 'https://playbook.example.com', fetchImpl });
}

async function connect(client: OutlineClient) {
  const server = createServer({ client });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

describe('OutlineClient', () => {
  it('posts to /api/<method> with Bearer token and appends /api to base', async () => {
    const rec: Rec[] = [];
    const client = makeClient(rec);
    await client.call('documents.info', { id: 'x' });
    expect(rec[0]?.url).toBe('https://playbook.example.com/api/documents.info');
  });

  it('refuses non-standard method names', async () => {
    const client = makeClient([]);
    await expect(client.call('documents.delete;drop')).rejects.toThrow('non-standard');
  });
});

describe('policy', () => {
  it('read tools open; write tools gated on OUTLINE_ENABLE_WRITES; unknown denied', () => {
    delete process.env.OUTLINE_ENABLE_WRITES;
    expect(checkToolPolicy('outline_search').allowed).toBe(true);
    expect(checkToolPolicy('outline_create_document').allowed).toBe(false);
    expect(checkToolPolicy('outline_purge_everything').allowed).toBe(false);
    process.env.OUTLINE_ENABLE_WRITES = 'true';
    expect(checkToolPolicy('outline_create_document').allowed).toBe(true);
  });
});

describe('tool surface', () => {
  it('registers exactly the capability set', async () => {
    const mcp = await connect(makeClient([]));
    const names = (await mcp.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(OUTLINE_CAPABILITIES.map(c => c.id).sort());
  });

  it('search maps to documents.search with filters', async () => {
    const rec: Rec[] = [];
    const mcp = await connect(makeClient(rec, () => ({ data: [], pagination: {} })));
    await mcp.callTool({ name: 'outline_search', arguments: { query: 'vpn', statusFilter: ['published'] } });
    const call = rec.find(r => r.url.endsWith('/documents.search'));
    expect((call?.body as { query: string }).query).toBe('vpn');
    expect((call?.body as { statusFilter: string[] }).statusFilter).toEqual(['published']);
  });

  it('delete_document never sends permanent:true and is gated', async () => {
    delete process.env.OUTLINE_ENABLE_WRITES;
    const rec: Rec[] = [];
    const mcp = await connect(makeClient(rec));
    const denied = await mcp.callTool({ name: 'outline_delete_document', arguments: { id: 'd1' } });
    expect(denied.isError).toBe(true);

    process.env.OUTLINE_ENABLE_WRITES = 'true';
    const rec2: Rec[] = [];
    const mcp2 = await connect(makeClient(rec2, () => ({ ok: true })));
    await mcp2.callTool({ name: 'outline_delete_document', arguments: { id: 'd1' } });
    const call = rec2.find(r => r.url.endsWith('/documents.delete'));
    expect(call?.body).toEqual({ id: 'd1' });
    expect(JSON.stringify(call?.body)).not.toContain('permanent');
  });
});
