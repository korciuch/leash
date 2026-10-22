import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-viewer-'));
process.env.LEASH_HOME = home;

// Small contract stub, used only if Lane A's gate modules are not present yet.
function stubGate() {
  const paths = {
    leashHome: () => process.env.LEASH_HOME,
    grantsPath: () => path.join(process.env.LEASH_HOME, 'grants.json'),
    ledgerPath: () => path.join(process.env.LEASH_HOME, 'ledger.jsonl'),
    draftsPath: () => path.join(process.env.LEASH_HOME, 'drafts.json'),
    ensureHome: () => fs.mkdirSync(process.env.LEASH_HOME, { recursive: true }),
  };
  const seedGrants = (now = new Date()) => {
    const hour = new Date(now.getTime() + 3600e3).toISOString();
    const c = now.toISOString();
    return [
      { id: 'g_plan_week', name: 'Plan the week', app: 'calendar', verbs: ['read'], records: { calendars: ['Leash Demo'], windowDays: 7 }, fields: ['title', 'start', 'end'], expiresAt: hour, createdAt: c, source: 'seed' },
      { id: 'g_draft_replies', name: 'Draft replies', app: 'mail', verbs: ['read', 'draft', 'send'], records: { mailboxes: [{ account: 'Alumni', mailbox: 'Leash Demo' }], sinceDays: 30 }, fields: ['from', 'subject', 'date', 'body'], expiresAt: hour, createdAt: c, source: 'seed' },
      { id: 'g_errands', name: 'Errands list', app: 'reminders', verbs: ['read', 'create'], records: { lists: ['Errands'] }, fields: ['*'], expiresAt: null, createdAt: c, source: 'seed' },
    ];
  };
  const write = (list) => {
    const p = paths.grantsPath();
    fs.writeFileSync(p + '.tmp', JSON.stringify({ grants: list }, null, 2));
    fs.renameSync(p + '.tmp', p);
  };
  const loadGrants = () => {
    paths.ensureHome();
    if (!fs.existsSync(paths.grantsPath())) write(seedGrants());
    return JSON.parse(fs.readFileSync(paths.grantsPath(), 'utf8')).grants;
  };
  const revokeGrant = (id) => {
    const list = loadGrants();
    const g = list.find((x) => x.id === id);
    if (!g) return null;
    g.revokedAt = new Date().toISOString();
    write(list);
    return g;
  };
  const readAll = () => {
    if (!fs.existsSync(paths.ledgerPath())) return [];
    return fs.readFileSync(paths.ledgerPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const hashOf = (e) => { const { hash, ...rest } = e; return createHash('sha256').update(JSON.stringify(rest)).digest('hex'); };
  const append = (partial) => {
    const all = readAll();
    const prev = all.length ? all.at(-1).hash : 'genesis';
    const body = { seq: all.length + 1, time: new Date().toISOString(), agent: 'claude', grantId: null, records: [], returned: '', ...partial, prev };
    const entry = { ...body, hash: hashOf(body) };
    fs.appendFileSync(paths.ledgerPath(), JSON.stringify(entry) + '\n');
    return entry;
  };
  const verify = () => {
    const all = readAll();
    let prev = 'genesis';
    for (const e of all) {
      if (e.prev !== prev || hashOf(e) !== e.hash) return { entries: all.length, intact: false, brokenAt: e.seq };
      prev = e.hash;
    }
    return { entries: all.length, intact: true };
  };
  return {
    grants: { loadGrants, revokeGrant, seedGrants },
    ledger: { append, readAll, tail: (n) => readAll().slice(-n), verify },
    paths,
  };
}

let viewer;
let gate;
let usingStub = false;

before(async () => {
  const { startViewer, loadGate } = await import('../src/viewer/server.mjs');
  try {
    gate = await loadGate();
  } catch {
    gate = stubGate();
    usingStub = true;
  }
  gate.paths.ensureHome();
  viewer = await startViewer({ port: 0, gate, pollMs: 200 });
});

after(async () => {
  await viewer?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function get(p, init) {
  const res = await fetch(viewer.url + p, init);
  return { status: res.status, type: res.headers.get('content-type'), body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}

test('serves index.html', async () => {
  if (usingStub) console.log('# viewer tests running against the local gate stub');
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.body, /<title>Leash<\/title>/);
  assert.ok(!r.body.includes(String.fromCharCode(0x2014)), 'no em dash in the page');
});

test('GET /api/grants lists seeded grants with active and msLeft', async () => {
  const r = await get('/api/grants');
  assert.equal(r.status, 200);
  const ids = r.body.grants.map((g) => g.id).sort();
  assert.deepEqual(ids, ['g_draft_replies', 'g_errands', 'g_plan_week']);
  const plan = r.body.grants.find((g) => g.id === 'g_plan_week');
  assert.equal(plan.active, true);
  assert.ok(plan.msLeft > 59 * 60e3 && plan.msLeft <= 60 * 60e3);
  const errands = r.body.grants.find((g) => g.id === 'g_errands');
  assert.equal(errands.active, true);
  assert.equal(errands.msLeft, null);
});

test('POST /api/grants/:id/revoke revokes and persists', async () => {
  const r = await get('/api/grants/g_plan_week/revoke', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.ok(r.body.grant.revokedAt);
  const after = await get('/api/grants');
  const plan = after.body.grants.find((g) => g.id === 'g_plan_week');
  assert.equal(plan.active, false);
  assert.ok(plan.revokedAt);
  const onDisk = JSON.parse(fs.readFileSync(gate.paths.grantsPath(), 'utf8')).grants;
  assert.ok(onDisk.find((g) => g.id === 'g_plan_week').revokedAt);

  const missing = await get('/api/grants/g_nope/revoke', { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('GET /api/ledger returns newest first with verify result', async () => {
  const base = { app: 'calendar', verb: 'read', grantId: 'g_plan_week', records: [], returned: '1 event' };
  gate.ledger.append({ ...base, tool: 'calendar_events', decision: 'allowed', summary: 'first' });
  gate.ledger.append({ ...base, tool: 'messages_send', app: 'messages', verb: 'send', decision: 'denied', summary: '<img src=x onerror=alert(1)>' });
  gate.ledger.append({ ...base, tool: 'calendar_events', decision: 'allowed', summary: 'third' });

  const r = await get('/api/ledger?limit=2');
  assert.equal(r.status, 200);
  assert.equal(r.body.entries.length, 2);
  assert.equal(r.body.entries[0].summary, 'third');
  assert.ok(r.body.entries[0].seq > r.body.entries[1].seq);
  assert.equal(r.body.verify.intact, true);
  assert.equal(r.body.verify.entries, 3);

  // Tamper with the middle entry: verify must flag it.
  const file = gate.paths.ledgerPath();
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n').filter(Boolean);
  const mid = JSON.parse(lines[1]);
  mid.summary = 'nothing to see here';
  lines[1] = JSON.stringify(mid);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const broken = await get('/api/ledger');
  assert.equal(broken.body.verify.intact, false);
  assert.equal(broken.body.verify.brokenAt, mid.seq);
  fs.writeFileSync(file, original);
});

test('GET /api/events pushes a change after a ledger append', async () => {
  const u = new URL(viewer.url + '/api/events');
  const got = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('no SSE change event within 4 s')); }, 4000);
    let buf = '';
    let appended = false;
    const req = http.get(u, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        if (!appended && buf.includes('event: hello')) {
          appended = true;
          gate.ledger.append({ tool: 'reminders_list', app: 'reminders', verb: 'read', grantId: 'g_errands', decision: 'allowed', summary: 'List Errands', records: [], returned: '3 reminders' });
        }
        const m = buf.match(/event: change\ndata: (.+)\n\n/);
        if (m) { clearTimeout(timer); req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on('error', (e) => { if (!/aborted|socket hang up/.test(e.message)) reject(e); });
  });
  assert.ok(got.kinds.includes('ledger'));
});

test('unknown route is 404', async () => {
  const r = await get('/api/nope');
  assert.equal(r.status, 404);
});
