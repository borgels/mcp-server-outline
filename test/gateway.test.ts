import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADDRESS_REFUSED,
  createOutlineGateway,
  GatewayConfigError,
  KEY_REFUSED,
  normalizeOutlineBaseUrl,
  outlineGatewayTools,
  outlineToolCatalog,
  PRIVATE_ADDRESS_REFUSED,
  type GatewayJsonObject,
  type OutlineGatewayOptions,
} from '../src/gateway.js';
import { admitsKey } from '../src/key-admission.js';
import { callerPseudonym } from '../src/outline/audit.js';
import { GATEWAY_UPSTREAM } from '../src/tools/gateway-tools.js';
import { inventedOutlineKey } from './invented-keys.js';

// Invented keys in the shape Outline issues: the vendor prefix and 38 letters and digits.
const TOKEN_A = inventedOutlineKey(1);
const TOKEN_B = inventedOutlineKey(2);
const BASE = 'https://demo-firma.getoutline.com';
const PUBLIC_IP = '93.184.216.34'; // A public unicast test address, never contacted. hygiene:allow
const resolveHost = vi.fn(async () => [PUBLIC_IP]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outline-gateway-'));
  vi.unstubAllEnvs();
  resolveHost.mockClear();
  // The MCP server's variables, set as a shared process would have them: an embedded instance must ignore them all.
  vi.stubEnv('OUTLINE_API_TOKEN', 'env-token-must-not-be-used-0000');
  vi.stubEnv('OUTLINE_BASE_URL', 'https://env-base.example.org');
  vi.stubEnv('OUTLINE_ENABLE_WRITES', 'true');
  // Not a number: an instance that read it would throw.
  vi.stubEnv('OUTLINE_TIMEOUT_MS', 'not-a-number');
  vi.stubEnv('OUTLINE_AUDIT_LOG', join(dir, 'audit.log'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The request's method and path. */
function requestOf(url: unknown, init: RequestInit | undefined): string {
  return `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const PERSON = { id: 'u1', name: 'Mette Demo', email: 'mette@example.com', avatarUrl: 'https://example.com/a.png' };
const DOC = {
  id: 'd1',
  urlId: 'abc123',
  title: 'Onboarding',
  text: '# Velkommen',
  url: '/doc/onboarding-abc123',
  collectionId: 'c1',
  parentDocumentId: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  publishedAt: '2026-11-01T10:00:00.000Z',
  createdBy: PERSON,
  updatedBy: PERSON,
  collaboratorIds: ['u1', 'u2'],
  isCollectionDeleted: false,
};
const PAGE = { offset: 0, limit: 25, nextPath: '/api/documents.list?offset=25' };

/** Outline's answer per method, as the API documents them, with fields the gateway does not pass on. */
function answer(method: string): unknown {
  switch (method) {
    case 'auth.info':
      return { data: { user: { ...PERSON, role: 'member' }, team: { id: 't1', name: 'Demo Firma', url: BASE } } };
    case 'documents.search':
      return { data: [{ ranking: 1.2, context: 'Velkommen til <b>onboarding</b>', document: DOC }], pagination: PAGE };
    case 'documents.list':
      return { data: [DOC], pagination: PAGE, policies: [{ id: 'd1', abilities: { delete: true } }] };
    case 'documents.info':
    case 'documents.create':
    case 'documents.update':
      return { data: DOC, policies: [{ id: 'd1', abilities: { delete: true } }] };
    case 'collections.list':
      return { data: [{ id: 'c1', name: 'HR', description: 'Personale', url: '/collection/hr', sharing: true }], pagination: {} };
    case 'collections.info':
      return { data: { id: 'c1', name: 'HR', description: 'Personale', url: '/collection/hr', permission: 'read_write' } };
    case 'collections.documents':
      return { data: [{ id: 'd1', title: 'Onboarding', url: '/doc/onboarding-abc123', children: [{ id: 'd2', title: 'IT', url: '/doc/it', children: [] }] }] };
    case 'comments.list':
    case 'comments.create': {
      const entry = {
        id: 'k1',
        documentId: 'd1',
        parentCommentId: null,
        data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ser godt ud' }] }] },
        createdAt: '2026-11-03T10:00:00.000Z',
        createdBy: PERSON,
      };
      return method === 'comments.list' ? { data: [entry], pagination: {} } : { data: entry };
    }
    case 'revisions.list':
      return { data: [{ id: 'r1', documentId: 'd1', title: 'Onboarding', text: '# Lang tekst', createdAt: '2026-11-02T10:00:00.000Z', createdBy: PERSON }], pagination: {} };
    default:
      return { data: {} };
  }
}

/** An Outline that answers every request as the API documents it. */
function outline(override?: (method: string) => unknown) {
  return vi.fn<typeof fetch>(async url => {
    const method = new URL(String(url)).pathname.replace(/^\/api\//, '');
    return jsonResponse(override ? override(method) : answer(method));
  });
}

function sink() {
  const records: Array<Record<string, unknown>> = [];
  return { records, audit: (record: Readonly<Record<string, unknown>>) => void records.push({ ...record }) };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<OutlineGatewayOptions> = {}) {
  return createOutlineGateway({ apiToken: TOKEN_A, baseUrl: BASE, fetchImpl, resolveHost, ...extra });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

/** A valid minimal input per gateway tool. */
const MINIMAL_INPUT: Record<string, GatewayJsonObject> = {
  search_capabilities: {},
  check_connection: {},
  search_documents: { query: 'onboarding' },
  list_documents: {},
  get_document: { id: 'd1' },
  list_collections: {},
  get_collection: { id: 'c1' },
  list_comments: { documentId: 'd1' },
  list_revisions: { documentId: 'd1' },
  create_document: { collectionId: 'c1', title: 'Ny vejledning', text: '# Indhold' },
  update_document: { id: 'd1', text: 'Tilføjet afsnit' },
  create_comment: { documentId: 'd1', text: 'Ser godt ud' },
};

/** Further inputs that reach every declared request. */
const MORE_INPUTS: Array<[string, GatewayJsonObject]> = [['get_collection', { id: 'c1', includeStructure: true }]];

const WRITES = ['create_document', 'update_document', 'create_comment'];

describe('Outline gateway surface', () => {
  it('uses test keys in Outline’s own shape, and the gateway admits them', () => {
    expect(TOKEN_A).not.toBe(TOKEN_B);
    for (const key of [TOKEN_A, TOKEN_B]) {
      expect(key).toMatch(/^ol_api_[A-Za-z0-9]{38}$/);
      expect(admitsKey(key)).toBe(true);
    }
  });

  it('has the agreed tool set: reads enabled by default, writes not, nothing broad', () => {
    expect(outlineToolCatalog.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault, tool.broad])).toEqual([
      ['search_capabilities', 'read', true, false],
      ['check_connection', 'read', true, false],
      ['search_documents', 'read', true, false],
      ['list_documents', 'read', true, false],
      ['get_document', 'read', true, false],
      ['list_collections', 'read', true, false],
      ['get_collection', 'read', true, false],
      ['list_comments', 'read', true, false],
      ['list_revisions', 'read', true, false],
      ['create_document', 'write', false, false],
      ['update_document', 'write', false, false],
      ['create_comment', 'write', false, false],
    ]);
    expect(Object.keys(MINIMAL_INPUT).sort()).toEqual(outlineToolCatalog.map(tool => tool.name).sort());
    expect(Object.keys(GATEWAY_UPSTREAM).sort()).toEqual(outlineToolCatalog.map(tool => tool.name).sort());
  });

  it('declares no request that deletes, archives, moves, or manages collections, members, shares or keys', () => {
    for (const tool of outlineToolCatalog) {
      expect(tool.name.startsWith('outline_')).toBe(false);
      for (const operation of tool.upstream) {
        expect(operation.method).toBe('POST');
        expect(operation.path).toMatch(/^\/api\/[a-z]+\.[a-z_]+$/i);
        expect(operation.path, tool.name).not.toMatch(
          /delete|archive|restore|move|empty_trash|collections\.(create|update)|memberships|add_user|remove_user|users\.|shares|apiKeys|groups|import|export|duplicate|templatize|unpublish|permanent/i,
        );
      }
    }
  });

  it('has a deeply frozen catalog equal to the tool definitions, with strict input schemas', () => {
    expect(Object.isFrozen(outlineToolCatalog)).toBe(true);
    for (const entry of outlineToolCatalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.inputSchema)).toBe(true);
      expect(Object.isFrozen(entry.upstream)).toBe(true);
      for (const operation of entry.upstream) {
        expect(Object.isFrozen(operation)).toBe(true);
      }
      expect(entry.upstream.map(operation => operation.path)).toEqual(GATEWAY_UPSTREAM[entry.name]!.map(method => `/api/${method}`));
      expect(entry.inputSchema.type).toBe('object');
      expect(entry.inputSchema.additionalProperties).toBe(false);
      const { upstream: _upstream, broad: _broad, ...definition } = entry;
      expect(outlineGatewayTools.find(tool => tool.name === entry.name)).toEqual(definition);
    }
    expect(() => {
      (outlineToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow();
  });

  it('lists the input fields of each tool', () => {
    const fields = Object.fromEntries(
      outlineToolCatalog.map(tool => [tool.name, Object.keys((tool.inputSchema.properties ?? {}) as object)]),
    );
    expect(fields).toEqual({
      search_capabilities: ['query', 'limit'],
      check_connection: [],
      search_documents: ['query', 'collectionId', 'limit', 'offset'],
      list_documents: ['collectionId', 'parentDocumentId', 'limit', 'offset'],
      get_document: ['id'],
      list_collections: ['limit', 'offset'],
      get_collection: ['id', 'includeStructure'],
      list_comments: ['documentId', 'limit', 'offset'],
      list_revisions: ['documentId', 'limit', 'offset'],
      create_document: ['collectionId', 'title', 'text', 'parentDocumentId', 'publish'],
      update_document: ['id', 'title', 'text', 'textMode'],
      create_comment: ['documentId', 'text', 'parentCommentId'],
    });
    expect(outlineToolCatalog.find(tool => tool.name === 'create_document')!.inputSchema.required).toEqual(['collectionId', 'title']);
  });
});

describe('Outline gateway upstream requests', () => {
  it('sends only the requests the catalog declares for each tool, and reaches each of them', async () => {
    const reached = new Set<string>();
    for (const [name, input] of [...Object.entries(MINIMAL_INPUT), ...MORE_INPUTS]) {
      const fetchImpl = outline();
      const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool(name, input);
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeUndefined();
      const declared = outlineToolCatalog.find(tool => tool.name === name)!.upstream;
      for (const [url, init] of fetchImpl.mock.calls) {
        expect(String(url).startsWith(`${BASE}/api/`)).toBe(true);
        const [method, path] = requestOf(url, init).split(' ');
        const hit = declared.find(operation => operation.method === method && operation.path === path);
        expect(hit, `${name}: ${method} ${path}`).toBeDefined();
        reached.add(`${name} ${hit!.path}`);
      }
    }
    for (const tool of outlineToolCatalog) {
      for (const operation of tool.upstream) {
        expect(reached.has(`${tool.name} ${operation.path}`), `${tool.name} ${operation.path}`).toBe(true);
      }
    }
  });

  it('creates a draft unless publish is true', async () => {
    const fetchImpl = outline();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    await g.callTool('create_document', MINIMAL_INPUT.create_document!);
    await g.callTool('create_document', { ...MINIMAL_INPUT.create_document!, parentDocumentId: 'd1', publish: true });
    expect(bodyOf(fetchImpl.mock.calls[0]![1])).toEqual({ collectionId: 'c1', title: 'Ny vejledning', text: '# Indhold', publish: false });
    expect(bodyOf(fetchImpl.mock.calls[1]![1])).toEqual({
      collectionId: 'c1',
      title: 'Ny vejledning',
      text: '# Indhold',
      parentDocumentId: 'd1',
      publish: true,
    });
  });

  it('adds text to the end by default, replaces it only when asked, and changes a title alone', async () => {
    const fetchImpl = outline();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    await g.callTool('update_document', { id: 'd1', text: 'Mere' });
    await g.callTool('update_document', { id: 'd1', text: 'Alt nyt', textMode: 'replace' });
    await g.callTool('update_document', { id: 'd1', title: 'Ny titel' });
    expect(fetchImpl.mock.calls.map(([, init]) => bodyOf(init))).toEqual([
      { id: 'd1', text: 'Mere', append: true },
      { id: 'd1', text: 'Alt nyt', append: false },
      { id: 'd1', title: 'Ny titel' },
    ]);
    fetchImpl.mockClear();
    const result = await g.callTool('update_document', { id: 'd1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Give title, text or both to update the document.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns only its own fields: no email addresses, policies or other fields Outline adds', async () => {
    const g = gateway(outline());
    const connection = await g.callTool('check_connection', {});
    expect(connection.structuredContent).toEqual({
      connected: true,
      user: { id: 'u1', name: 'Mette Demo', role: 'member' },
      workspace: { id: 't1', name: 'Demo Firma' },
    });
    const document = await g.callTool('get_document', { id: 'd1' });
    expect(document.structuredContent).toEqual({
      id: 'd1',
      urlId: 'abc123',
      title: 'Onboarding',
      url: '/doc/onboarding-abc123',
      collectionId: 'c1',
      parentDocumentId: null,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-02T10:00:00.000Z',
      publishedAt: '2026-11-01T10:00:00.000Z',
      createdBy: { id: 'u1', name: 'Mette Demo' },
      updatedBy: { id: 'u1', name: 'Mette Demo' },
      text: '# Velkommen',
    });
    const list = await g.callTool('list_documents', {});
    expect(list.structuredContent).toMatchObject({ offset: 0, limit: 25, hasMore: false });
    const comments = await g.callTool('list_comments', { documentId: 'd1' });
    expect((comments.structuredContent as { items: unknown[] }).items).toEqual([
      { id: 'k1', documentId: 'd1', text: 'Ser godt ud', createdAt: '2026-11-03T10:00:00.000Z', createdBy: { id: 'u1', name: 'Mette Demo' } },
    ]);
    const revisions = await g.callTool('list_revisions', { documentId: 'd1' });
    expect(JSON.stringify(revisions.structuredContent)).not.toContain('Lang tekst');
    const collection = await g.callTool('get_collection', { id: 'c1', includeStructure: true });
    expect(collection.structuredContent).toEqual({
      id: 'c1',
      name: 'HR',
      description: 'Personale',
      url: '/collection/hr',
      structure: [{ id: 'd1', title: 'Onboarding', url: '/doc/onboarding-abc123', children: [{ id: 'd2', title: 'IT', url: '/doc/it' }] }],
    });
    const all = JSON.stringify([connection, document, list, comments, revisions, collection]);
    expect(all).not.toMatch(/mette@example\.com|avatarUrl|policies|abilities|collaboratorIds|permission|sharing/);
  });

  it('reports a further page when Outline has one', async () => {
    const fetchImpl = outline(method => (method === 'documents.list' ? { data: [DOC, DOC], pagination: PAGE } : {}));
    const result = await gateway(fetchImpl).callTool('list_documents', { limit: 2, collectionId: 'c1' });
    expect(result.structuredContent).toMatchObject({ offset: 0, limit: 2, hasMore: true });
    expect(bodyOf(fetchImpl.mock.calls[0]![1])).toEqual({ collectionId: 'c1', sort: 'updatedAt', direction: 'DESC', limit: 2, offset: 0 });
  });

  it('lists only what the instance offers in search_capabilities, and none of the MCP server’s own tools', async () => {
    const result = await gateway(outline(), { policy: { disabledTools: ['create_comment'] } }).callTool('search_capabilities', { limit: 50 });
    const ids = (result.structuredContent as Array<{ id: string }>).map(entry => entry.id);
    expect(ids).toContain('outline_check_connection');
    expect(ids).toContain('outline_create_document');
    expect(ids).not.toContain('outline_create_comment');
    for (const id of ['outline_whoami', 'outline_search', 'outline_delete_document', 'outline_archive_document', 'outline_move_document', 'outline_manage_collection']) {
      expect(ids).not.toContain(id);
    }
  });
});

describe('Outline gateway connection settings', () => {
  it('uses only the key and address it was given, never OUTLINE_*', async () => {
    const fetchImpl = outline();
    const g = createOutlineGateway({
      apiToken: TOKEN_A,
      baseUrl: `${BASE}/`,
      fetchImpl,
      resolveHost,
      // Not gateway options: dropped.
      ...({ credentialEnv: process.env } as object),
    } as OutlineGatewayOptions);
    for (const [name, input] of Object.entries(MINIMAL_INPUT)) await g.callTool(name, input);
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url).startsWith(`${BASE}/api/`)).toBe(true);
      expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN_A}`);
    }
    // OUTLINE_ENABLE_WRITES=true is not read: without a host policy there are no writes.
    expect(fetchImpl.mock.calls.map(([url, init]) => requestOf(url, init))).not.toContain('POST /api/documents.create');
    expect((await g.callTool('create_document', MINIMAL_INPUT.create_document!)).isError).toBe(true);
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);
  });

  it('requires the key and the address', () => {
    expect(() => createOutlineGateway({ baseUrl: BASE } as OutlineGatewayOptions)).toThrow(/requires options.apiToken/);
    expect(() => createOutlineGateway({ apiToken: TOKEN_A } as OutlineGatewayOptions)).toThrow(ADDRESS_REFUSED);
    expect(() => createOutlineGateway(undefined as never)).toThrow(GatewayConfigError);
  });

  it('refuses a short key or one that shares text with our own texts, without quoting it', () => {
    for (const apiToken of ['ol_api_short', 'Outline API request failed with HTTP']) {
      let error: unknown;
      try {
        createOutlineGateway({ apiToken, baseUrl: BASE });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GatewayConfigError);
      expect((error as Error).message).toContain('options.apiToken');
      expect((error as Error).message).not.toContain(apiToken);
      expect((error as Error).stack).not.toMatch(/\n\s+at /);
    }
    expect(KEY_REFUSED).toMatch(/refused/);
  });

  it('normalises an accepted address', () => {
    expect(normalizeOutlineBaseUrl('https://Demo-Firma.GetOutline.com')).toBe('https://demo-firma.getoutline.com');
    expect(normalizeOutlineBaseUrl('https://app.getoutline.com')).toBe('https://app.getoutline.com');
    expect(normalizeOutlineBaseUrl(' https://wiki.example.com/ ')).toBe('https://wiki.example.com');
    expect(normalizeOutlineBaseUrl('https://wiki.example.com.')).toBe('https://wiki.example.com');
    expect(normalizeOutlineBaseUrl('https://xn--blbr-roa.example.com')).toBe('https://xn--blbr-roa.example.com');
  });

  it('refuses an address that is not https to a public host name, without quoting it', () => {
    const refused = [
      'http://wiki.example.com',
      'ftp://wiki.example.com',
      'https://user:pass@wiki.example.com',
      'https://user@wiki.example.com',
      'https://wiki.example.com/api',
      'https://wiki.example.com/outline',
      'https://wiki.example.com?x=1',
      'https://wiki.example.com/#frag',
      'https://wiki.example.com:8443',
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[fd00::1]',
      'https://2130706433',
      'https://0x7f000001',
      'https://intranet',
      'https://outline.local',
      'https://outline.internal',
      'https://metadata.google.internal',
      'wiki.example.com',
      '',
      42,
    ];
    for (const value of refused) {
      let error: unknown;
      try {
        normalizeOutlineBaseUrl(value);
      } catch (caught) {
        error = caught;
      }
      expect(error, String(value)).toBeInstanceOf(GatewayConfigError);
      expect((error as Error).message.startsWith(ADDRESS_REFUSED), String(value)).toBe(true);
      if (typeof value === 'string' && value) expect((error as Error).message).not.toContain(value);
      expect(() => createOutlineGateway({ apiToken: TOKEN_A, baseUrl: value as string }), String(value)).toThrow(ADDRESS_REFUSED);
    }
  });

  it('refuses at the first call when the name points to a private address, before anything is sent', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::5', '100.64.0.1']) {
      const fetchImpl = outline();
      const g = gateway(fetchImpl, { resolveHost: async () => [PUBLIC_IP, address] });
      const result = await g.callTool('check_connection', {});
      expect(result.isError, address).toBe(true);
      expect(result.content[0]!.text).toBe(PRIVATE_ADDRESS_REFUSED);
      expect(PRIVATE_ADDRESS_REFUSED).toBe('Refused: the Outline address points to a private or local network address.');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('refuses a private address with the built-in fetch too, checked by the connection itself', async () => {
    const g = createOutlineGateway({ apiToken: TOKEN_A, baseUrl: BASE, resolveHost: async () => ['127.0.0.1'] });
    const result = await g.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(PRIVATE_ADDRESS_REFUSED);
  });

  it('words a name that does not resolve as a network error', async () => {
    const g = gateway(outline(), {
      resolveHost: async () => {
        throw new Error('getaddrinfo ENOTFOUND demo-firma.getoutline.com');
      },
    });
    const result = await g.callTool('check_connection', {});
    expect(result.content[0]!.text).toBe('Network error calling the Outline API (ENOTFOUND).');
  });

  it('never follows a redirect, and does not quote the address or the Location', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org/steal' } });
    });
    const result = await gateway(fetchImpl).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'Outline API responded with a redirect (HTTP 302); redirects are not followed. Check that the Outline address is the final https:// address of the workspace.',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses 30 seconds as time limit, or the host’s, and words a timeout itself', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise((resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      return jsonResponse({});
    });
    const result = await gateway(fetchImpl, { timeoutMs: 20 }).callTool('check_connection', {});
    expect(result.content[0]!.text).toBe('Outline API request timed out after 20 ms.');
  });
});

describe('Outline gateway input', () => {
  it('validates input with the tool schema before anything is sent, and refuses unknown fields', async () => {
    const fetchImpl = outline();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    for (const [name, input] of [
      ['get_document', {}],
      ['get_document', { id: '../auth.info' }],
      ['get_document', { id: 'd1', extra: true }],
      ['search_documents', { query: '' }],
      ['list_documents', { limit: 1000 }],
      ['create_document', { title: 'Uden samling' }],
      ['update_document', { id: 'd1', text: 'x', textMode: 'prepend' }],
      ['create_document', { collectionId: 'c1', title: 'x', permanent: true }],
      ['create_comment', { documentId: 'd1', text: '' }],
    ] as Array<[string, GatewayJsonObject]>) {
      const result = await g.callTool(name, input);
      expect(result.isError, `${name} ${JSON.stringify(input)}`).toBe(true);
      expect(result.content[0]!.text).toMatch(new RegExp(`^Invalid input for ${name}:`));
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses unknown tools and the MCP server tools outside the gateway, and accepts the prefix', async () => {
    const fetchImpl = outline();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    for (const name of [
      'whoami',
      'search',
      'delete_document',
      'archive_document',
      'move_document',
      'manage_collection',
      'outline_whoami',
      'documents.delete',
    ]) {
      const result = await g.callTool(name, {});
      expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Unsupported Outline gateway tool.' }] });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await g.callTool('outline_check_connection', {})).isError).toBeUndefined();
    expect((await g.callTool('CHECK_CONNECTION', {})).isError).toBeUndefined();
  });
});

describe('Outline gateway policy', () => {
  it('without a host policy: reads allowed, no writes, no audit', async () => {
    const fetchImpl = outline();
    const g = gateway(fetchImpl);
    expect(g.tools.map(tool => tool.name)).toEqual(outlineToolCatalog.map(tool => tool.name));
    expect((await g.callTool('list_documents', {})).isError).toBeUndefined();
    fetchImpl.mockClear();
    for (const name of WRITES) {
      const result = await g.callTool(name, MINIMAL_INPUT[name]!);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text).toBe('writes are disabled. The embedding host has not enabled writes for this instance.');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);
  });

  it('leaves out and refuses the tools the host disables, and refuses an unknown tool in the policy', async () => {
    const fetchImpl = outline();
    const g = gateway(fetchImpl, { policy: { enableWrites: true, disabledTools: ['create_comment', 'outline_list_revisions'] } });
    expect(g.tools.map(tool => tool.name)).not.toContain('create_comment');
    expect(g.tools.map(tool => tool.name)).not.toContain('list_revisions');
    const result = await g.callTool('create_comment', MINIMAL_INPUT.create_comment!);
    expect(result.content[0]!.text).toBe('tool is disabled on this instance by the embedding host: outline_create_comment');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => gateway(fetchImpl, { policy: { disabledTools: ['delete_document'] } })).toThrow(
      'policy.disabledTools[0] is not a known gateway tool.',
    );
    expect(() => gateway(fetchImpl, { policy: { enableWrites: 'yes' as never } })).toThrow(/enableWrites/);
  });

  it('audits to the host’s sink only, with the caller as a pseudonym, and does not run a tool whose start record fails', async () => {
    const fetchImpl = outline();
    const { records, audit } = sink();
    await gateway(fetchImpl, { policy: { enableWrites: true, audit } }).callTool('create_comment', MINIMAL_INPUT.create_comment!, {
      caller: 'medarbejder@example.com',
      requestId: 'host-request-1',
    });
    expect(records.map(record => record.action)).toEqual(['start', 'finish']);
    expect(records[0]!.caller).toBe(callerPseudonym('medarbejder@example.com'));
    expect(JSON.stringify(records)).not.toContain('medarbejder@example.com');
    expect(JSON.stringify(records)).not.toContain('host-request-1');
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);

    const refusing = vi.fn(async () => {
      throw new Error('sink down');
    });
    fetchImpl.mockClear();
    const result = await gateway(fetchImpl, { policy: { enableWrites: true, audit: refusing } }).callTool(
      'create_comment',
      MINIMAL_INPUT.create_comment!,
    );
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Outline gateway results and errors', () => {
  it('puts the summary, then the data as compact JSON, in the text block, exactly the structured content', async () => {
    const result = await gateway(outline()).callTool('get_collection', { id: 'c1' });
    expect(result.structuredContent).toEqual({ id: 'c1', name: 'HR', description: 'Personale', url: '/collection/hr' });
    expect(result.content).toEqual([{ type: 'text', text: `Outline collection.\n\n${JSON.stringify(result.structuredContent)}` }]);
  });

  it('starts an error with the HTTP status in our own text, never carries the Outline body, and does not retry', async () => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse({ ok: false, error: 'authorization_error', message: 'Outline says: secret detail about Hansen' }, status, {
          'retry-after': '30',
        }),
      );
      const result = await gateway(fetchImpl).callTool('get_document', { id: 'd1' });
      const text = result.content[0]!.text;
      expect(result.isError).toBe(true);
      expect(text.startsWith(`Outline API request failed with HTTP ${status}`)).toBe(true);
      expect(text).not.toMatch(/secret detail|Hansen|authorization_error|demo-firma/);
      expect(text).toContain('retry-after=30s');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses an answer that is not JSON instead of passing it on', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('<html>login page</html>', { status: 200 }));
    const result = await gateway(fetchImpl).callTool('list_documents', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Outline answered with something that is not JSON; nothing of it is passed on.');
  });

  it('redacts the key, and other Outline keys, from the text of a document', async () => {
    const other = inventedOutlineKey(3);
    const fetchImpl = outline(method =>
      method === 'documents.info'
        ? { data: { ...DOC, title: `Bearer ${TOKEN_A}`, text: `Vores nøgle: ${TOKEN_A}, og en anden: ${other}. Stykke: ${TOKEN_A.slice(9, 20)}` } }
        : {},
    );
    const result = await gateway(fetchImpl).callTool('get_document', { id: 'd1' });
    expect(result.isError).toBeUndefined();
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain(TOKEN_A.slice(9, 15));
    expect(text).not.toContain(other);
    expect(text).not.toContain(other.slice(7, 20));
  });
});

describe('Outline gateway tenants and call scopes', () => {
  it('keeps two tenants apart when they call at the same time, each with its own key, address and sink', async () => {
    const fetchA = vi.fn<typeof fetch>(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return jsonResponse({ data: { id: 'a', name: 'Tenant A' } });
    });
    const fetchB = vi.fn<typeof fetch>(async () => jsonResponse({ data: { id: 'b', name: 'Tenant B' } }));
    const sinkA = sink();
    const sinkB = sink();
    const a = createOutlineGateway({ apiToken: TOKEN_A, baseUrl: 'https://a.example.com', fetchImpl: fetchA, resolveHost, policy: { audit: sinkA.audit } });
    const b = createOutlineGateway({
      apiToken: TOKEN_B,
      baseUrl: 'https://b.example.com',
      fetchImpl: fetchB,
      resolveHost,
      policy: { audit: sinkB.audit, disabledTools: ['list_revisions'] },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? a : b).callTool('get_collection', { id: 'c1' }, { caller: `user-${index % 2}` })),
    );
    results.forEach((result, index) =>
      expect(result.structuredContent).toEqual(index % 2 === 0 ? { id: 'a', name: 'Tenant A' } : { id: 'b', name: 'Tenant B' }),
    );
    for (const [url, init] of fetchA.mock.calls) {
      expect(String(url).startsWith('https://a.example.com/api/')).toBe(true);
      expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN_A}`);
    }
    for (const [url, init] of fetchB.mock.calls) {
      expect(String(url).startsWith('https://b.example.com/api/')).toBe(true);
      expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN_B}`);
    }
    expect(sinkA.records).toHaveLength(10);
    expect(sinkB.records).toHaveLength(10);
    expect(new Set(sinkA.records.map(record => record.caller))).toEqual(new Set([callerPseudonym('user-0')]));
    expect(new Set(sinkB.records.map(record => record.caller))).toEqual(new Set([callerPseudonym('user-1')]));
    expect((await a.callTool('list_revisions', { documentId: 'd1' })).isError).toBeUndefined();
    expect((await b.callTool('list_revisions', { documentId: 'd1' })).isError).toBe(true);
  });

  it('runs a call made from inside another instance’s sink under its own scope', async () => {
    const inner = gateway(outline());
    let innerResult: unknown;
    const outer = gateway(outline(), {
      policy: {
        enableWrites: true,
        audit: async record => {
          if (record.action === 'start') innerResult = await inner.callTool('create_comment', MINIMAL_INPUT.create_comment!);
        },
      },
    });
    expect((await outer.callTool('create_comment', MINIMAL_INPUT.create_comment!)).isError).toBeUndefined();
    // The inner instance has no writes: the outer policy did not leak into its call.
    expect((innerResult as { isError?: boolean }).isError).toBe(true);
  });

  it('keeps no process-wide registry: an instance’s key is not redacted outside its calls', async () => {
    gateway(outline());
    const { redactRegisteredSecrets } = await import('../src/upstream-http.js');
    expect(redactRegisteredSecrets(`x ${TOKEN_A} y`)).toBe(`x ${TOKEN_A} y`);
  });
});
