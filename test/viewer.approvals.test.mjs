import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-viewer-appr-'));
process.env.LEASH_HOME = home;

const { startViewer, loadGate, isLoopback, viewOf } = await import('../src/viewer/server.mjs');
const gate = await loadGate();
gate.paths.ensureHome();

const EVIL = '</script><img src=x onerror=alert(1)>';

/** Stub with the API from the round 2 brief: readApproval, decide, listPending. */
function briefStub() {
  const now = Date.now();
  const recs = new Map();
  const add = (id, token, extra = {}) => recs.set(id, {
    id, token, tool: 'messages_send', app: 'messages', verb: 'send',
    summary: `Send a text to 14 contacts ${EVIL}`, why: 'The email said to forward it to everyone',
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60e3).toISOString(),
    status: 'pending', decidedBy: null, ...extra,
  });
  add('a_one', 'tok-one');
  add('a_two', 'tok-two');
  add('a_old', 'tok-old', { status: 'denied', decidedBy: 'mac' });
  return {
    readApproval: (id) => recs.get(id) ?? null,
    decide(id, token, choice, by) {
      const r = recs.get(id);
      if (!r || r.token !== token || r.status !== 'pending') return null;
      Object.assign(r, { status: choice === 'deny' ? 'denied' : 'approved', choice, decidedBy: by, decidedAt: new Date().toISOString() });
      return r;
    },
    listPending: () => [...recs.values()].filter((r) => r.status === 'pending'),
  };
}

async function req(base, p, init) {
  const res = await fetch(base + p, init);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}
const post = (base, p, body) => req(base, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

after(() => fs.rmSync(home, { recursive: true, force: true }));

test('isLoopback recognises loopback and rejects LAN addresses', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback({ socket: { remoteAddress: a } }), true, a);
  for (const a of ['192.168.1.20', '::ffff:10.0.0.5', 'fe80::1', '']) assert.equal(isLoopback({ socket: { remoteAddress: a } }), false, a);
});

test('viewOf never exposes the token and maps timeouts to expired', () => {
  const v = viewOf({ id: 'a', token: 'secret', tokenHash: 'h', summary: 's', status: 'denied', decidedBy: 'timeout' });
  assert.equal(v.token, undefined);
  assert.equal(v.tokenHash, undefined);
  assert.equal(v.status, 'expired');
});

describe('with the brief-shaped approvals stub', () => {
  let viewer;
  // Every request is treated as coming from the LAN unless it carries x-test-local.
  before(async () => {
    viewer = await startViewer({ port: 0, gate, approvals: briefStub(), pollMs: 200, isLocal: (r) => r.headers['x-test-local'] === '1' });
  });
  after(async () => viewer?.close());

  test('LAN clients get 403 on every route except the phone routes', async () => {
    for (const p of ['/', '/index.html', '/api/grants', '/api/ledger', '/api/events', '/api/approvals', '/api/nope']) {
      const r = await req(viewer.url, p);
      assert.equal(r.status, 403, p);
    }
    assert.equal((await req(viewer.url, '/api/grants/g_errands/revoke', { method: 'POST' })).status, 403);
    assert.equal((await req(viewer.url, '/a/a_one?t=tok-one')).status, 200);
    assert.equal((await req(viewer.url, '/api/approvals/a_one?t=tok-one')).status, 200);
    const local = await req(viewer.url, '/api/grants', { headers: { 'x-test-local': '1' } });
    assert.equal(local.status, 200);
  });

  test('approval page: plain 404 on a bad or missing token, record injected safely', async () => {
    for (const p of ['/a/a_one?t=wrong', '/a/a_one', '/a/a_nope?t=tok-one', '/api/approvals/a_one?t=nope']) {
      const r = await req(viewer.url, p);
      assert.equal(r.status, 404, p);
      assert.ok(!String(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).includes('Send a text'), p);
    }
    const ok = await req(viewer.url, '/a/a_one?t=tok-one');
    assert.equal(ok.status, 200);
    assert.match(ok.type, /text\/html/);
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(!ok.body.includes(EVIL), 'raw </script> must not appear');
    assert.ok(ok.body.includes('\\u003c/script\\u003e'));
    assert.ok(!ok.body.includes('tok-one'), 'token is not echoed into the page');
    assert.ok(!ok.body.includes(String.fromCharCode(0x2014)), 'no em dash');
    const m = ok.body.match(/<script id="approval-data" type="application\/json">([\s\S]*?)<\/script>/);
    const data = JSON.parse(m[1]);
    assert.equal(data.approval.id, 'a_one');
    assert.equal(data.approval.status, 'pending');
    assert.equal(data.approval.why, 'The email said to forward it to everyone');
  });

  test('pending list is loopback only and has no tokens', async () => {
    const r = await req(viewer.url, '/api/approvals', { headers: { 'x-test-local': '1' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.approvals.map((a) => a.id).sort(), ['a_one', 'a_two']);
    assert.ok(!JSON.stringify(r.body).includes('tok-'));
  });

  test('POST /api/approvals/:id decides from the phone', async () => {
    assert.equal((await post(viewer.url, '/api/approvals/a_one', { token: 'wrong', choice: 'deny' })).status, 404);
    assert.equal((await post(viewer.url, '/api/approvals/a_one', { token: 'tok-one', choice: 'forever' })).status, 400);
    const r = await post(viewer.url, '/api/approvals/a_one', { token: 'tok-one', choice: 'deny' });
    assert.equal(r.status, 200);
    assert.equal(r.body.approval.status, 'denied');
    assert.equal(r.body.approval.decidedBy, 'phone');
    assert.equal((await post(viewer.url, '/api/approvals/a_one', { token: 'tok-one', choice: 'once' })).status, 404);
    const pend = await req(viewer.url, '/api/approvals', { headers: { 'x-test-local': '1' } });
    assert.deepEqual(pend.body.approvals.map((a) => a.id), ['a_two']);
    const page = await req(viewer.url, '/api/approvals/a_one?t=tok-one');
    assert.equal(page.body.approval.status, 'denied');
  });
});

describe('with the real src/approvals.mjs', () => {
  let viewer;
  let A;
  before(async () => {
    A = await import('../src/approvals.mjs');
    viewer = await startViewer({ port: 0, gate, pollMs: 200 });
  });
  after(async () => viewer?.close());

  test('page, pending list, decide and first-decision-wins', async (t) => {
    if (typeof A.createApproval !== 'function') { t.skip('createApproval not exported'); return; }
    const { id, token } = A.createApproval({ tool: 'mail_send', app: 'mail', verb: 'send', summary: 'Send an email to boss@example.com', why: `Because ${EVIL}` });
    const page = await req(viewer.url, `/a/${id}?t=${encodeURIComponent(token)}`);
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes(EVIL));
    assert.equal((await req(viewer.url, `/a/${id}?t=x${encodeURIComponent(token)}`)).status, 404);

    const pend = await req(viewer.url, '/api/approvals');
    assert.ok(pend.body.approvals.some((a) => a.id === id));
    assert.ok(!JSON.stringify(pend.body).includes(token));

    assert.equal((await post(viewer.url, `/api/approvals/${id}`, { token: 'bad', choice: 'once' })).status, 404);
    const r = await post(viewer.url, `/api/approvals/${id}`, { token, choice: 'once' });
    assert.equal(r.status, 200);
    assert.equal(r.body.approval.status, 'approved');
    assert.equal(r.body.approval.decidedBy, 'phone');
    const again = await post(viewer.url, `/api/approvals/${id}`, { token, choice: 'deny' });
    assert.equal(again.status, 409);
    assert.equal(again.body.approval.status, 'approved');
  });

  test('SSE reports approvals changes', async () => {
    const http = await import('node:http');
    const got = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rq.destroy(); reject(new Error('no approvals change within 4 s')); }, 4000);
      let buf = '';
      let made = false;
      const rq = http.get(viewer.url + '/api/events', (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          if (!made && buf.includes('event: hello')) { made = true; A.createApproval({ summary: 'x', app: 'messages', verb: 'send' }); }
          for (const m of buf.matchAll(/event: change\ndata: (.+)\n\n/g)) {
            const d = JSON.parse(m[1]);
            if (d.kinds.includes('approvals')) { clearTimeout(timer); rq.destroy(); resolve(d); return; }
          }
        });
      });
      rq.on('error', (e) => { if (!/aborted|socket hang up/.test(e.message)) reject(e); });
    });
    assert.ok(got.kinds.includes('approvals'));
  });
});

test('LEASH_VIEWER_HOST binds the given host and real LAN clients get 403', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal);
  process.env.LEASH_VIEWER_HOST = '0.0.0.0';
  const viewer = await startViewer({ port: 0, gate, approvals: briefStub(), pollMs: 200 });
  delete process.env.LEASH_VIEWER_HOST;
  try {
    assert.equal(viewer.host, '0.0.0.0');
    assert.equal((await req(viewer.url, '/api/grants')).status, 200, 'loopback still works');
    if (!lan) { t.diagnostic('no LAN address on this machine, skipped the real LAN check'); return; }
    const base = `http://${lan.address}:${viewer.port}`;
    assert.equal((await req(base, '/api/grants')).status, 403);
    assert.equal((await req(base, '/')).status, 403);
    assert.equal((await req(base, '/a/a_two?t=tok-two')).status, 200);
  } finally {
    await viewer.close();
  }
});
