#!/usr/bin/env node
// Leash MCP server over Streamable HTTP, for Claude Code running inside a VM on this Mac.
// Same tools, gate and ledger as the stdio server. Every request needs Authorization: Bearer <LEASH_HTTP_TOKEN>.
import { createServer as createHttpServer } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer, loadDeps, startupCheck } from './server.mjs';

export const AGENT = 'claude-code (VM)';
const MIN_TOKEN = 24;
const MAX_BODY = 4 * 1024 * 1024;

const log = (...parts) => process.stderr.write(`[leash-http] ${parts.join(' ')}\n`);

const digest = (s) => createHash('sha256').update(String(s)).digest();

/** Constant-time check of the Authorization header against the token. */
export function authorized(header, token) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  if (!m) return false;
  return timingSafeEqual(digest(m[1].trim()), digest(token));
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch { reject(new Error('Parse error')); }
    });
    req.on('error', reject);
  });
}

/**
 * Start the HTTP MCP server.
 * @param {object} opts
 * @param {string} opts.token bearer token, at least 24 chars
 * @param {object} [opts.deps] Leash deps (tests pass fakes); default loadDeps()
 * @param {string} [opts.host] default LEASH_HTTP_HOST or 0.0.0.0
 * @param {number} [opts.port] default LEASH_HTTP_PORT or 4778; 0 picks a free port
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function start(opts = {}) {
  const token = opts.token ?? process.env.LEASH_HTTP_TOKEN;
  if (!token || String(token).length < MIN_TOKEN) {
    throw new Error(`LEASH_HTTP_TOKEN must be set and at least ${MIN_TOKEN} characters.`);
  }
  const host = opts.host ?? process.env.LEASH_HTTP_HOST ?? '0.0.0.0';
  const port = opts.port ?? Number(process.env.LEASH_HTTP_PORT || 4778);
  const base = opts.deps || await loadDeps();
  const deps = { ...base, agent: AGENT, agentName: 'Claude Code (VM)' };

  /** @type {Map<string, { transport: StreamableHTTPServerTransport, server: any }>} */
  const sessions = new Map();

  async function handle(req, res) {
    const path = new URL(req.url || '/', 'http://x').pathname;
    if (!authorized(req.headers.authorization, token)) {
      return sendJson(res, 401, rpcError(-32001, 'Unauthorized'), { 'www-authenticate': 'Bearer' });
    }
    if (path !== '/mcp') return sendJson(res, 404, rpcError(-32601, 'Not found: use /mcp'));
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return sendJson(res, 405, rpcError(-32601, 'Method not allowed'), { allow: 'POST, GET, DELETE' });

    const sid = req.headers['mcp-session-id'];
    let body;
    if (req.method === 'POST') {
      try { body = await readJson(req); } catch (e) { return sendJson(res, 400, rpcError(-32700, e.message)); }
    }

    if (sid) {
      const s = sessions.get(String(sid));
      if (!s) return sendJson(res, 404, rpcError(-32001, 'Session not found'));
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      return sendJson(res, 400, rpcError(-32000, 'Bad request: no valid session id'));
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, server }); log(`session ${id} opened`); }
    });
    transport.onclose = () => {
      if (transport.sessionId && sessions.delete(transport.sessionId)) log(`session ${transport.sessionId} closed`);
    };
    const { server } = createServer(deps);
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }

  const http = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      log('request failed:', error && error.stack || error);
      sendJson(res, 500, rpcError(-32603, 'Internal error'));
    });
  });
  http.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.off('error', reject); resolve(); });
  });
  const actual = http.address().port;
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${shown}:${actual}/mcp`;
  log(`MCP over HTTP on ${url} (bound ${host}:${actual}), agent "${AGENT}"`);

  return {
    url,
    port: actual,
    async close() {
      for (const { transport, server } of sessions.values()) {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
      sessions.clear();
      http.closeAllConnections?.();
      await new Promise((resolve) => http.close(() => resolve()));
    }
  };
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  (async () => {
    const deps = await loadDeps();
    await start({ deps });
    startupCheck({ ...deps, agent: AGENT });
  })().catch((error) => {
    log('fatal:', error && error.message || error);
    process.exit(1);
  });
}
