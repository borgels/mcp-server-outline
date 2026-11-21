// Failure metadata on gateway error results: Outline's HTTP status and its request id (a UUID or hex id only),
// for a host that counts failures without reading their text. Never the body, the vendor's code or message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failureMetadata, OutlineHttpError, requestIdFrom, vendorRequestId } from '../src/errors.js';
import { createOutlineGateway } from '../src/gateway.js';
import { inventedOutlineKey } from './invented-keys.js';

const TOKEN = inventedOutlineKey(1);
const BASE = 'https://demo-firma.getoutline.com';
const PUBLIC_IP = '93.184.216.34'; // A public unicast test address, never contacted. hygiene:allow
const resolveHost = async () => [PUBLIC_IP];
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const BODY = { message: 'Customer Jane Doe not found', code: 'E_NOPE' };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('OUTLINE_AUDIT_LOG', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function gatewayAnswering(status: number, headers: Record<string, string>, body: unknown = BODY, apiToken = TOKEN) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as typeof fetch;
  return createOutlineGateway({ apiToken, baseUrl: BASE, fetchImpl, resolveHost });
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'a-------',
      'abc--def',
      'abcd--ef12',
      'abcdef12-ab',
      'abcdef1',
      'abcdef12-'.repeat(8),
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-correlation-id': 'deadbeefcafe' }))).toBe('deadbeefcafe');
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
  });

  it('gives metadata for an HTTP error only', () => {
    expect(failureMetadata(new OutlineHttpError({ status: 404, url: `${BASE}/api/auth.info`, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new OutlineHttpError({ status: 500, url: `${BASE}/api/auth.info`, requestId: 'Jane Doe' }))).toEqual({
      httpStatus: 500,
    });
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
    expect(failureMetadata('boom')).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    const result = await gatewayAnswering(404, { 'x-request-id': UUID }).callTool('check_connection');
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayAnswering(422, { 'x-request-id': 'Jane Doe <jane@example.com>' }).callTool(
      'check_connection',
    );
    expect(result.failure).toEqual({ httpStatus: 422 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of the key', async () => {
    // The key's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const result = await gatewayAnswering(500, { 'x-request-id': 'deadbeef00112233' }, {}, 'deadbeef00112233-key-0').callTool(
      'check_connection',
    );
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not Outline', async () => {
    const gw = gatewayAnswering(200, { 'x-request-id': UUID }, { data: {} });
    expect((await gw.callTool('get_document', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = createOutlineGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      resolveHost,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const result = await offline.callTool('check_connection');
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const result = await gatewayAnswering(200, { 'x-request-id': UUID }, {
      data: { user: { id: 'u1', name: 'Mette Demo' }, team: { id: 't1', name: 'Demo' } },
    }).callTool(
      'check_connection',
    );
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
