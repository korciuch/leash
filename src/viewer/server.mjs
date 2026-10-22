#!/usr/bin/env node
// Leash stage viewer: active grants with countdowns and a Revoke button, plus the live ledger.
// Routes:
//   GET  /                         index.html
//   GET  /api/grants               { grants: [Grant + { active, msLeft }], now }
//   POST /api/grants/:id/revoke    { grant } or 404
//   GET  /api/ledger?limit=200     { entries (newest first), verify: { entries, intact, brokenAt? } }
//   GET  /api/events               Server-Sent Events: 'change' when grants.json or ledger.jsonl changes

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, 'index.html');

/** Load the real gate modules (Lane A). */
export async function loadGate() {
  const [grants, ledger, paths] = await Promise.all([
    import('../gate/grants.mjs'),
    import('../gate/ledger.mjs'),
    import('../gate/paths.mjs'),
  ]);
  return { grants, ledger, paths };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function isActive(g, now) {
  if (g.revokedAt) return false;
  if (g.expiresAt == null) return true;
  return Date.parse(g.expiresAt) > now;
}

/** Fingerprint a file cheaply so the poller can tell when it changed. */
function stamp(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return 'missing';
  }
}

/**
 * Start the viewer.
 * @param {{ port?: number, host?: string, gate?: any, pollMs?: number }} [opts]
 * @returns {Promise<{ server: http.Server, port: number, url: string, close: () => Promise<void> }>}
 */
export async function startViewer(opts = {}) {
  const gate = opts.gate ?? (await loadGate());
  const { grants: G, ledger: L, paths: P } = gate;
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.LEASH_VIEWER_PORT ?? 4777);
  const pollMs = opts.pollMs ?? 1000;

  P.ensureHome?.();
  // Make sure grants.json exists (loadGrants seeds it when missing).
  try { G.loadGrants(); } catch { /* reported per request */ }

  const clients = new Set();
  let seq = 0;
  let pending = null;
  let pendingKinds = new Set();

  function broadcast(kind) {
    pendingKinds.add(kind);
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const kinds = [...pendingKinds];
      pendingKinds = new Set();
      const data = JSON.stringify({ kinds, time: new Date().toISOString() });
      const msg = `id: ${++seq}\nevent: change\ndata: ${data}\n\n`;
      for (const res of clients) res.write(msg);
    }, 60);
  }

  // Change detection: fs.watch on the data directory (atomic renames replace the file, so
  // watching the file itself would go deaf), plus a stat poller as the fallback.
  const grantsFile = () => P.grantsPath();
  const ledgerFile = () => P.ledgerPath();
  const last = { grants: stamp(grantsFile()), ledger: stamp(ledgerFile()) };
  function check() {
    const g = stamp(grantsFile());
    const l = stamp(ledgerFile());
    if (g !== last.grants) { last.grants = g; broadcast('grants'); }
    if (l !== last.ledger) { last.ledger = l; broadcast('ledger'); }
  }
  let watcher = null;
  try {
    watcher = fs.watch(P.leashHome(), { persistent: false }, () => check());
    watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; });
  } catch {
    watcher = null;
  }
  const poller = setInterval(check, pollMs);
  poller.unref();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 15000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(indexPath);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && p === '/api/grants') {
        const now = Date.now();
        const grants = G.loadGrants().map((g) => {
          const active = G.isActive ? G.isActive(g, new Date(now)) : isActive(g, now);
          const msLeft = g.expiresAt == null ? null : Math.max(0, Date.parse(g.expiresAt) - now);
          return { ...g, active, msLeft };
        });
        sendJson(res, 200, { grants, now: new Date(now).toISOString() });
        return;
      }

      const m = p.match(/^\/api\/grants\/([^/]+)\/revoke$/);
      if (m && req.method === 'POST') {
        req.resume();
        const id = decodeURIComponent(m[1]);
        const grant = G.revokeGrant(id, 'viewer');
        if (!grant) { sendJson(res, 404, { error: `No grant with id ${id}` }); return; }
        check();
        sendJson(res, 200, { grant });
        return;
      }

      if (req.method === 'GET' && p === '/api/ledger') {
        const raw = Number(url.searchParams.get('limit') ?? 200);
        const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 5000) : 200;
        const entries = L.tail(limit).slice().reverse();
        const verify = L.verify();
        sendJson(res, 200, { entries, verify });
        return;
      }

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 1000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;

  async function close() {
    clearInterval(poller);
    clearInterval(heartbeat);
    if (pending) clearTimeout(pending);
    try { watcher?.close(); } catch {}
    for (const res of clients) res.end();
    clients.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, port: actual, url: `http://${host}:${actual}`, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startViewer()
    .then(({ url }) => process.stderr.write(`Leash viewer on ${url}\n`))
    .catch((err) => {
      process.stderr.write(`Leash viewer failed to start: ${err.message}\n`);
      process.exit(1);
    });
}
