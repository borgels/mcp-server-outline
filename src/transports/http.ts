import { createServer as createNodeServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import { OutlineClient } from '../outline/client.js';
import { KeyStore } from '../outline/store.js';
import { trustForwardedUser } from '../outline/policy.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  corsHeaders,
  getHttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

const config = getHttpConfig();

// Shared, long-lived across requests: the Outline client (one instance/base URL)
// and the encrypted per-user key store. Per-request MCP servers bind to the
// calling user and use that user's own personal API key.
const client = new OutlineClient();
const store = new KeyStore();

if (process.env.OUTLINE_API_TOKEN) {
  console.error(
    'WARNING: OUTLINE_API_TOKEN is set but ignored in HTTP mode — every call uses the calling user’s own key. Remove it from the environment.',
  );
}

const httpServer = createNodeServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Enrollment form — the user's browser reaches this directly (Caddy routes
    // /outline/* to the container, NOT via the gateway), so it must NOT require
    // the gateway bearer. Security comes from the single-use, user-bound `state`.
    if (url.pathname === '/outline/enroll') {
      await handleEnroll(req, res, url);
      return;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' }, req);
      return;
    }

    assertAllowedOrigin(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, req, { Allow: 'POST' });
      return;
    }

    assertAuthorized(req, config);
    const body = await readJsonBody(req, config.maxBodyBytes);

    const forwardedUser = trustForwardedUser() ? firstHeader(req.headers['x-mcp-user']) : undefined;

    const mcpServer = createMcpServer({ client, store, onBehalfOf: forwardedUser });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      if (error instanceof HttpRequestError) {
        sendJson(res, error.status, { error: error.message }, req);
        return;
      }

      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      }, req);
    }
  }
});

/**
 * GET renders the paste-your-key form for a still-valid state; POST validates the
 * key against Outline (auth.info) before storing it encrypted for that user. The
 * key never passes through Claude — only through the user's own browser.
 */
async function handleEnroll(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === 'GET') {
    const state = url.searchParams.get('state') ?? '';
    if (!store.peekState(state)) {
      page(res, 'Link expired', '<p>Run <code>outline_connect</code> again in Claude to get a fresh link.</p>', false);
      return;
    }
    page(res, 'Connect Playbook', form(state));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, POST' });
    res.end();
    return;
  }

  const fields = await readForm(req);
  const state = fields.state ?? '';
  const user = store.peekState(state);
  if (!user) {
    page(res, 'Link expired', '<p>Run <code>outline_connect</code> again in Claude to get a fresh link.</p>', false);
    return;
  }

  const apiToken = (fields.apiToken ?? '').trim();
  if (!apiToken) {
    page(res, 'Connect Playbook', form(state, 'Paste your API key.'), false);
    return;
  }

  try {
    // Validate before storing: a wrong key should fail here, not on first use.
    const info = await client.call<{ data?: { user?: Record<string, unknown>; team?: Record<string, unknown> } }>(
      'auth.info',
      {},
      { apiToken },
    );
    const outlineUser = info?.data?.user ?? {};
    store.setKey(user, {
      apiToken,
      outlineUserId: asString(outlineUser.id),
      outlineUserName: asString(outlineUser.name),
      outlineEmail: asString(outlineUser.email),
      workspaceName: asString(info?.data?.team?.name),
      connectedAt: Date.now(),
    });
    store.consumeState(state);
    page(
      res,
      'Playbook connected',
      `<p>Linked as <b>${escapeHtml(asString(outlineUser.name) ?? user)}</b>. Close this tab and return to Claude.</p>`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    page(res, 'Connection failed', form(state, message.slice(0, 200)), false);
  }
}

function form(state: string, error = ''): string {
  const err = error ? `<p style="color:#b00">${escapeHtml(error)}</p>` : '';
  return (
    `${err}<p>Paste <b>your own</b> Playbook API key. Create one at ` +
    `<b>Playbook → Settings → API → New API key</b>. It gives this connector exactly the collections you can already ` +
    `see — nothing more — and is stored encrypted, bound to your account.</p>` +
    `<form method="post">` +
    `<input type="hidden" name="state" value="${escapeHtml(state)}">` +
    `<input name="apiToken" type="password" autocomplete="off" placeholder="ol_api_…" style="padding:.5rem;width:100%">` +
    `<button style="margin-top:1rem;padding:.6rem 1rem">Connect</button></form>`
  );
}

function page(res: ServerResponse, title: string, bodyHtml: string, ok = true): void {
  const html =
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui;max-width:26rem;margin:3rem auto;padding:0 1rem">` +
    `<h1>${ok ? '✅' : '⚠️'} ${escapeHtml(title)}</h1>${bodyHtml}</body>`;
  res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > 64_000) {
      throw new HttpRequestError(413, 'Payload too large');
    }
    chunks.push(buffer);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

httpServer.listen(config.port, config.host, () => {
  console.error(`Outline MCP HTTP server listening on http://${config.host}:${config.port} (/mcp + /outline/enroll)`);
});
