import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OutlineClient } from '../src/outline/client.js';
import { createServer } from '../src/server.js';
import { checkToolPolicy } from '../src/outline/policy.js';
import { OUTLINE_CAPABILITIES } from '../src/outline/capabilities.js';
import { KeyStore } from '../src/outline/store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function textOf(result: unknown): string {
  return ((result as { content?: { text?: string }[] }).content?.[0]?.text) ?? '';
}

function makeStore(): KeyStore {
  return new KeyStore({
    path: join(mkdtempSync(join(tmpdir(), 'outline-store-')), 'store.json'),
    encryptionKey: 'test-key-that-is-long-enough',
  });
}

async function connect(client: OutlineClient, extra: { store?: KeyStore; onBehalfOf?: string } = {}) {
  const server = createServer({ client, ...extra });
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

describe('KeyStore', () => {
  it('round-trips an encrypted key and keeps it out of getKeyInfo', () => {
    const store = makeStore();
    store.setKey('Abo@Borgels.com', { apiToken: 'ol_api_secret', outlineUserName: 'Abo', connectedAt: 1 });
    expect(store.getKey('abo@borgels.com')?.apiToken).toBe('ol_api_secret');
    expect(JSON.stringify(store.getKeyInfo('abo@borgels.com'))).not.toContain('ol_api_secret');
    expect(store.getKey('someone.else@borgels.com')).toBeUndefined();
    expect(store.deleteKey('abo@borgels.com')).toBe(true);
    expect(store.getKey('abo@borgels.com')).toBeUndefined();
  });

  it('enrollment state is user-bound and single-use', () => {
    const store = makeStore();
    const state = store.createState('abo@borgels.com');
    expect(store.peekState(state)).toBe('abo@borgels.com');
    expect(store.consumeState(state)).toBe('abo@borgels.com');
    expect(store.consumeState(state)).toBeUndefined();
  });
});

describe('per-user API keys', () => {
  it('uses the calling user’s own key and never a shared one', async () => {
    const store = makeStore();
    store.setKey('abo@borgels.com', { apiToken: 'personal-key', connectedAt: Date.now() });
    const rec: Rec[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      rec.push({ url: String(input), body: (init?.headers as Record<string, string>)?.Authorization });
      return new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new OutlineClient({ apiToken: 'shared-fallback', baseUrl: 'https://playbook.example.com', fetchImpl });

    const mcp = await connect(client, { store, onBehalfOf: 'abo@borgels.com' });
    await mcp.callTool({ name: 'outline_search', arguments: { query: 'vpn' } });
    expect(rec[0]?.body).toBe('Bearer personal-key');
  });

  it('refuses without a verified identity, and without a linked key', async () => {
    const store = makeStore();
    const anonymous = await connect(makeClient([]), { store });
    expect((await anonymous.callTool({ name: 'outline_search', arguments: { query: 'x' } })).isError).toBe(true);

    const unlinked = await connect(makeClient([]), { store, onBehalfOf: 'new.user@borgels.com' });
    const result = await unlinked.callTool({ name: 'outline_search', arguments: { query: 'x' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('outline_connect');
  });

  it('outline_status reports linkage without leaking the key', async () => {
    const store = makeStore();
    store.setKey('abo@borgels.com', { apiToken: 'personal-key', outlineUserName: 'Abo', connectedAt: Date.now() });
    const mcp = await connect(makeClient([]), { store, onBehalfOf: 'abo@borgels.com' });
    const result = await mcp.callTool({ name: 'outline_status', arguments: {} });
    const text = textOf(result);
    expect(JSON.parse(text)).toMatchObject({ connected: true, outlineUserName: 'Abo' });
    expect(text).not.toContain('personal-key');
  });

  it('outline_connect hands back a single-use enrollment link on this instance', async () => {
    process.env.OUTLINE_PUBLIC_BASE_URL = 'https://playbook.bos.mcp.borgels.com';
    const store = makeStore();
    const mcp = await connect(makeClient([]), { store, onBehalfOf: 'abo@borgels.com' });
    const result = await mcp.callTool({ name: 'outline_connect', arguments: {} });
    const payload = JSON.parse(textOf(result)) as { enrollmentUrl: string };
    expect(payload.enrollmentUrl).toMatch(/^https:\/\/playbook\.bos\.mcp\.borgels\.com\/outline\/enroll\?state=/);
    expect(store.peekState(new URL(payload.enrollmentUrl).searchParams.get('state') ?? '')).toBe('abo@borgels.com');
  });
});
