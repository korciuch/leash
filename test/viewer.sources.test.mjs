import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-sources-'));
process.env.LEASH_HOME = home;

const STUB = {
  mail: [{ account: 'Alumni', mailboxes: ['INBOX', 'Leash Demo', 'Sent'] }],
  calendars: ['Leash Demo', 'Leash Personal'],
  lists: ['Errands', 'Reminders'],
  errors: [],
};

let viewer;
let calls = 0;

before(async () => {
  const { startViewer, loadGate } = await import('../src/viewer/server.mjs');
  const gate = await loadGate();
  gate.paths.ensureHome();
  viewer = await startViewer({ port: 0, gate, pollMs: 200, sources: async () => { calls++; return STUB; } });
});

after(async () => {
  await viewer?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const post = (body) => fetch(viewer.url + '/api/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const good = () => ({
  name: 'Triage demo inbox', app: 'mail', verbs: ['read', 'draft'],
  records: { mailboxes: [{ account: 'Alumni', mailbox: 'Leash Demo' }], sinceDays: 30 },
  fields: ['from', 'subject', 'date', 'body'], expiresInMin: 60,
});

test('GET /api/sources returns the runner result and caches it', async () => {
  const a = await (await fetch(viewer.url + '/api/sources')).json();
  const b = await (await fetch(viewer.url + '/api/sources')).json();
  assert.deepEqual(a, STUB);
  assert.deepEqual(b, STUB);
  assert.equal(calls, 1);
});

test('POST /api/grants creates a valid mail grant that shows in GET /api/grants', async () => {
  const res = await post(good());
  assert.equal(res.status, 200);
  const { grant } = await res.json();
  assert.match(grant.id, /^g_/);
  assert.equal(grant.source, 'viewer');
  assert.deepEqual(grant.records, good().records);
  const left = Date.parse(grant.expiresAt) - Date.now();
  assert.ok(left > 59 * 60e3 && left <= 60 * 60e3);
  const list = await (await fetch(viewer.url + '/api/grants')).json();
  const shown = list.grants.find((g) => g.id === grant.id);
  assert.ok(shown);
  assert.equal(shown.active, true);
  assert.equal(shown.name, 'Triage demo inbox');
});

test('this session expiry stores null', async () => {
  const res = await post({ ...good(), expiresInMin: null });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).grant.expiresAt, null);
});

test('POST /api/grants rejects a bad verb', async () => {
  const res = await post({ ...good(), verbs: ['read', 'delete'] });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /delete/);
});

test('POST /api/grants rejects an empty mailbox list', async () => {
  const res = await post({ ...good(), records: { mailboxes: [], sinceDays: 30 } });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /mailbox/i);
});

test('POST /api/grants rejects bad fields, expiry, window and name', async () => {
  assert.equal((await post({ ...good(), fields: ['notes'] })).status, 400);
  assert.equal((await post({ ...good(), expiresInMin: 30 })).status, 400);
  assert.equal((await post({ ...good(), name: '' })).status, 400);
  assert.equal((await post({ name: 'Cal', app: 'calendar', verbs: ['read'], records: { calendars: ['Leash Demo'], windowDays: 40 }, fields: ['title'], expiresInMin: 15 })).status, 400);
  assert.equal((await post({ name: 'Cal', app: 'calendar', verbs: ['read'], records: { calendars: ['Leash Demo'], windowDays: 7 }, fields: ['title'], expiresInMin: 15 })).status, 200);
  assert.equal((await post({ name: 'Errands', app: 'reminders', verbs: ['create'], records: { lists: ['Errands'] }, fields: ['*'], expiresInMin: 240 })).status, 200);
});
