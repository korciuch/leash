#!/usr/bin/env node
// Leash stage viewer: active grants with countdowns and a Revoke button, plus the live ledger.
// Routes:
//   GET  /                         index.html
//   GET  /api/grants               { grants: [Grant + { active, msLeft }], now }
//   POST /api/grants/:id/revoke    { grant } or 404
//   GET  /api/ledger?limit=200     { entries (newest first), verify: { entries, intact, brokenAt? } }
//   GET  /api/events               Server-Sent Events: 'change' when grants.json, ledger.jsonl or approvals/ change
//   GET  /api/approvals            { approvals: pending (tokens stripped), now }
//   GET  /api/sources              { mail, calendars, lists, errors } (Apple names, cached 30 s)
//   POST /api/grants               create a grant from the New grant card (validated)
// Phone routes (the only routes reachable from a non-loopback address, token gated):
//   GET  /a/:id?t=token            phone approval page (plain 404 on a bad id or token)
//   GET  /api/approvals/:id?t=token  { approval, now } or 404
//   POST /api/approvals/:id        { token, choice: 'deny' | 'once' } -> approvals.decide(id, token, choice, 'phone')
// Bind address: LEASH_VIEWER_HOST (default 127.0.0.1). Every other route answers 403 off loopback.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, 'index.html');
const approvePath = path.join(here, 'approve.html');

/** Load Lane F's approvals module lazily, so the viewer still runs without it. */
export async function loadApprovals() {
  return import('../approvals.mjs');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** @param {http.IncomingMessage} req */
export function isLoopback(req) {
  const a = req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(a) || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when `token` matches the record. Records without a token field were checked by readApproval. */
function tokenOk(record, token) {
  if (typeof token !== 'string' || !token) return false;
  if (typeof record.token === 'string') return sameToken(record.token, token);
  if (typeof record.tokenHash === 'string') return sameToken(record.tokenHash, createHash('sha256').update(token).digest('hex'));
  return true;
}

/**
 * Adapt either approvals API to { read, decide, pending }:
 *   brief:  readApproval(id, token), decide(id, token, choice, by) -> record | null, listPending()
 *   Lane F: getApproval(id), checkToken(id, token), decideApproval(id, token, choice, { by }) -> { ok, error, approval }, listApprovals()
 */
export function adaptApprovals(A) {
  return {
    async read(id, token) {
      if (typeof token !== 'string' || !token) return null;
      if (typeof A.checkToken === 'function' && typeof A.getApproval === 'function') {
        return (await A.checkToken(id, token)) ? await A.getApproval(id) : null;
      }
      const r = await A.readApproval(id, token);
      return r && tokenOk(r, token) ? r : null;
    },
    /** @returns {Promise<{ status: number, approval?: any }>} */
    async decide(id, token, choice, by) {
      if (typeof A.decideApproval === 'function') {
        const out = await A.decideApproval(id, token, choice, { by });
        if (out?.ok) return { status: 200, approval: out.approval };
        if (out?.approval && (out.error === 'already_decided' || out.error === 'expired')) return { status: 409, approval: out.approval };
        return { status: 404 };
      }
      const r = await A.decide(id, token, choice, by);
      return r ? { status: 200, approval: r } : { status: 404 };
    },
    async pending() {
      if (typeof A.listPending === 'function') return (await A.listPending()) || [];
      if (typeof A.listApprovals === 'function') return ((await A.listApprovals()) || []).filter((r) => r.status === 'pending');
      return [];
    },
  };
}

const DONE = { deny: 'denied', denied: 'denied', once: 'approved', approved: 'approved', 'approved once': 'approved', allow: 'approved', expired: 'expired' };

/** Shape any approval record into what the pages need. Never includes the token. */
export function viewOf(r, now = Date.now()) {
  const a = r.action || {};
  const raw = String(r.status ?? r.choice ?? r.decision ?? r.outcome ?? '').toLowerCase();
  let status = DONE[raw] || (r.decidedAt ? (/den/.test(raw) ? 'denied' : 'approved') : 'pending');
  const expiresAt = r.expiresAt ?? null;
  if (status === 'pending' && expiresAt && Date.parse(expiresAt) <= now) status = 'expired';
  if (status === 'denied' && r.decidedBy === 'timeout') status = 'expired';
  return {
    id: r.id,
    summary: r.summary ?? a.summary ?? '',
    why: r.why ?? a.why ?? '',
    app: r.app ?? a.app ?? '',
    verb: r.verb ?? a.verb ?? '',
    tool: r.tool ?? a.tool ?? '',
    recipients: r.recipients ?? a.target?.recipients ?? null,
    createdAt: r.createdAt ?? null,
    expiresAt,
    status,
    decidedBy: r.decidedBy ?? null,
    decidedAt: r.decidedAt ?? null,
  };
}

/** JSON safe to drop inside a <script> element. */
function scriptJson(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function readBody(req, max = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('Not found');
}

const GRANT_SPEC = {
  calendar: { verbs: ['read'], fields: ['title', 'start', 'end', 'location', 'notes'] },
  mail: { verbs: ['read', 'draft', 'send'], fields: ['from', 'to', 'subject', 'date', 'body'] },
  reminders: { verbs: ['read', 'create'], fields: ['title', 'notes', 'completed', 'due'] },
};
const EXPIRY_MIN = new Set([15, 60, 240]);
const isName = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;

/**
 * Validate a New grant request. Returns { grant } (a partial for addGrant) or { error }.
 * @param {any} b
 */
export function grantFromRequest(b, now = Date.now()) {
  if (!b || typeof b !== 'object') return { error: 'Send a JSON object.' };
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 60) return { error: 'Name must be 1 to 60 characters.' };
  const spec = GRANT_SPEC[b.app];
  if (!spec) return { error: 'App must be calendar, mail or reminders.' };
  const verbs = Array.isArray(b.verbs) ? [...new Set(b.verbs)] : [];
  if (!verbs.length) return { error: 'Pick at least one verb.' };
  const badVerb = verbs.find((v) => !spec.verbs.includes(v));
  if (badVerb !== undefined) return { error: `${b.app} grants allow only: ${spec.verbs.join(', ')} (got "${String(badVerb)}").` };
  const r = b.records && typeof b.records === 'object' ? b.records : {};
  let records;
  if (b.app === 'calendar') {
    const calendars = Array.isArray(r.calendars) ? [...new Set(r.calendars)] : [];
    if (!calendars.length || !calendars.every(isName)) return { error: 'Pick at least one calendar.' };
    const windowDays = Number(r.windowDays);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 31) return { error: 'Next N days must be a whole number from 1 to 31.' };
    records = { calendars, windowDays };
  } else if (b.app === 'mail') {
    const boxes = Array.isArray(r.mailboxes) ? r.mailboxes : [];
    if (!boxes.length || !boxes.every((m) => m && isName(m.account) && isName(m.mailbox))) return { error: 'Pick at least one mailbox.' };
    const sinceDays = Number(r.sinceDays);
    if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 365) return { error: 'Last N days must be a whole number from 1 to 365.' };
    records = { mailboxes: boxes.map((m) => ({ account: m.account, mailbox: m.mailbox })), sinceDays };
  } else {
    const lists = Array.isArray(r.lists) ? [...new Set(r.lists)] : [];
    if (!lists.length || !lists.every(isName)) return { error: 'Pick at least one list.' };
    records = { lists };
  }
  const fields = Array.isArray(b.fields) ? [...new Set(b.fields)] : [];
  if (!fields.length) return { error: 'Pick at least one field.' };
  const star = b.app === 'reminders' && fields.length === 1 && fields[0] === '*';
  if (!star) {
    const badField = fields.find((f) => !spec.fields.includes(f));
    if (badField !== undefined) return { error: `Unknown ${b.app} field "${String(badField)}". Known: ${spec.fields.join(', ')}.` };
  }
  let expiresAt = null;
  if (b.expiresInMin !== null && b.expiresInMin !== undefined) {
    if (!EXPIRY_MIN.has(b.expiresInMin)) return { error: 'Expiry must be 15, 60 or 240 minutes, or this session.' };
    expiresAt = new Date(now + b.expiresInMin * 60e3).toISOString();
  } else if (b.expiresInMin === undefined) {
    return { error: 'Pick an expiry.' };
  }
  return { grant: { name, app: b.app, verbs, records, fields, expiresAt, source: 'viewer' } };
}

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

/** Fingerprint a directory's files (names, sizes, mtimes). */
function stampDir(dir) {
  try {
    return fs.readdirSync(dir).sort().map((n) => n + ':' + stamp(path.join(dir, n))).join('|');
  } catch {
    return 'missing';
  }
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
 * @param {{ port?: number, host?: string, gate?: any, approvals?: any, sources?: () => Promise<any>, pollMs?: number, isLocal?: (req: http.IncomingMessage) => boolean }} [opts]
 * @returns {Promise<{ server: http.Server, port: number, url: string, close: () => Promise<void> }>}
 */
export async function startViewer(opts = {}) {
  const gate = opts.gate ?? (await loadGate());
  const { grants: G, ledger: L, paths: P } = gate;
  const host = opts.host ?? (process.env.LEASH_VIEWER_HOST || '127.0.0.1');
  const isLocal = opts.isLocal ?? isLoopback;
  let approvalsMod = opts.approvals ? adaptApprovals(opts.approvals) : null;
  async function approvals() {
    if (!approvalsMod) approvalsMod = adaptApprovals(await loadApprovals());
    return approvalsMod;
  }
  const port = opts.port ?? Number(process.env.LEASH_VIEWER_PORT ?? 4777);
  const pollMs = opts.pollMs ?? 1000;
  const sourcesRunner = opts.sources ?? (async () => {
    const { runScript } = await import('../apple/jxa.mjs');
    return runScript('sources', {}, { timeoutMs: 20000 });
  });
  let sourcesCache = null;

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
  const approvalsDir = () => path.join(P.leashHome(), 'approvals');
  const last = { grants: stamp(grantsFile()), ledger: stamp(ledgerFile()), approvals: stampDir(approvalsDir()) };
  function check() {
    const g = stamp(grantsFile());
    const l = stamp(ledgerFile());
    const a = stampDir(approvalsDir());
    if (g !== last.grants) { last.grants = g; broadcast('grants'); }
    if (l !== last.ledger) { last.ledger = l; broadcast('ledger'); }
    if (a !== last.approvals) { last.approvals = a; broadcast('approvals'); watchApprovals(); }
  }
  let approvalsWatcher = null;
  function watchApprovals() {
    if (approvalsWatcher) return;
    try {
      approvalsWatcher = fs.watch(approvalsDir(), { persistent: false }, () => check());
      approvalsWatcher.on('error', () => { try { approvalsWatcher.close(); } catch {} approvalsWatcher = null; });
    } catch {
      approvalsWatcher = null;
    }
  }
  watchApprovals();
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
      const pageMatch = p.match(/^\/a\/([A-Za-z0-9_-]{1,128})$/);
      const apiMatch = p.match(/^\/api\/approvals\/([A-Za-z0-9_-]{1,128})$/);
      const phoneRoute = (req.method === 'GET' && (pageMatch || apiMatch)) || (req.method === 'POST' && apiMatch);
      if (!phoneRoute && !isLocal(req)) {
        req.resume();
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Forbidden: this page only answers on the Mac itself.');
        return;
      }

      if (req.method === 'GET' && (pageMatch || apiMatch)) {
        const id = (pageMatch || apiMatch)[1];
        const token = url.searchParams.get('t') ?? '';
        const A = await approvals();
        const record = await A.read(id, token);
        if (!record) { notFound(res); return; }
        const view = viewOf(record);
        const now = new Date().toISOString();
        if (apiMatch) { sendJson(res, 200, { approval: view, now }); return; }
        const html = fs.readFileSync(approvePath, 'utf8')
          .replace('__APPROVAL_JSON__', () => scriptJson({ approval: view, now }));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && apiMatch) {
        const id = apiMatch[1];
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
          sendJson(res, e.status ?? 400, { error: 'Send JSON: { token, choice }' });
          return;
        }
        const token = typeof body?.token === 'string' ? body.token : '';
        const choice = body?.choice;
        if (!token) { notFound(res); return; }
        if (choice !== 'deny' && choice !== 'once') { sendJson(res, 400, { error: "choice must be 'deny' or 'once'" }); return; }
        const A = await approvals();
        const out = await A.decide(id, token, choice, 'phone');
        if (!out.approval) { notFound(res); return; }
        check();
        sendJson(res, out.status, { approval: viewOf(out.approval), now: new Date().toISOString() });
        return;
      }

      if (req.method === 'GET' && p === '/api/approvals') {
        const A = await approvals();
        const now = Date.now();
        const list = await A.pending();
        const pending = list.map((r) => viewOf(r, now)).filter((v) => v.status === 'pending');
        sendJson(res, 200, { approvals: pending, now: new Date(now).toISOString() });
        return;
      }
      if (req.method === 'GET' && p === '/api/sources') {
        if (!sourcesCache || Date.now() - sourcesCache.at > 30000) {
          try {
            sourcesCache = { at: Date.now(), data: await sourcesRunner() };
          } catch (err) {
            sendJson(res, 502, { error: String(err?.message ?? err), fix: err?.fix ?? null });
            return;
          }
        }
        sendJson(res, 200, sourcesCache.data);
        return;
      }

      if (req.method === 'POST' && p === '/api/grants') {
        let body;
        try { body = JSON.parse((await readBody(req)) || 'null'); } catch (e) {
          res.writeHead(e.status ?? 400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Send the grant as JSON.');
          return;
        }
        const out = grantFromRequest(body);
        if (out.error) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end(out.error);
          return;
        }
        const grant = G.addGrant(out.grant);
        check();
        sendJson(res, 200, { grant });
        return;
      }

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
    try { approvalsWatcher?.close(); } catch {}
    for (const res of clients) res.end();
    clients.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return { server, port: actual, host, url: `http://${shown.includes(':') ? `[${shown}]` : shown}:${actual}`, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startViewer()
    .then(({ url }) => process.stderr.write(`Leash viewer on ${url}\n`))
    .catch((err) => {
      process.stderr.write(`Leash viewer failed to start: ${err.message}\n`);
      process.exit(1);
    });
}
