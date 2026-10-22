// Approvals store and askAnywhere: Mac dialog and phone link race, first decision wins, timeout denies.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as approvals from '../src/approvals.mjs';
import { createAskAnywhere } from '../src/consent/anywhere.mjs';
import { start } from '../src/consent/dialog.mjs';

beforeEach(() => {
  process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), 'leash-appr-'));
  delete process.env.LEASH_PUBLIC_URL;
  delete process.env.LEASH_PHONE;
});

const action = { tool: 'messages_send', app: 'messages', verb: 'send', summary: 'Send a Messages text to 1 contact: "hi"' };
const parse = (url) => { const u = new URL(url); return { id: u.pathname.split('/').pop(), token: u.searchParams.get('t') }; };

/** A dialog whose answer the test controls, with a fake child that records kill(). */
function fakeDialog() {
  const state = { killed: false, shown: [], answer: null };
  return {
    state,
    start({ message }) {
      state.shown.push(message);
      let resolve;
      const result = new Promise((r) => { resolve = r; });
      state.answer = (choice) => resolve(choice);
      return { result, cancel() { state.killed = true; resolve('deny'); } };
    }
  };
}

test('store: create, token check, decide once, expiry, no token on disk', () => {
  const { id, token, approval } = approvals.createApproval({ ...action, why: 'Tell Sam I am late' });
  assert.match(id, /^a_[0-9a-f]{16}$/);
  assert.equal(approval.status, 'pending');
  assert.equal(approval.why, 'Tell Sam I am late');
  const raw = readFileSync(join(process.env.LEASH_HOME, 'approvals', `${id}.json`), 'utf8');
  assert.ok(!raw.includes(token));
  assert.ok(!('tokenHash' in approvals.getApproval(id)));

  assert.equal(approvals.checkToken(id, token), true);
  assert.equal(approvals.checkToken(id, token + 'x'), false);
  assert.equal(approvals.checkToken(id, ''), false);
  assert.deepEqual(approvals.decideApproval(id, 'wrong', 'once'), { ok: false, error: 'bad_token' });
  assert.equal(approvals.decideApproval(id, token, 'maybe').error, 'bad_choice');
  assert.equal(approvals.decideApproval('../grants', token, 'once').error, 'not_found');

  const first = approvals.decideApproval(id, token, 'once');
  assert.equal(first.ok, true);
  assert.equal(first.approval.decidedBy, 'phone');
  assert.equal(first.approval.status, 'approved');
  assert.equal(approvals.decideApproval(id, token, 'deny').error, 'already_decided');
  assert.equal(approvals.markDecided(id, 'deny', 'mac').error, 'already_decided');
  assert.equal(approvals.getApproval(id).choice, 'once');
  assert.ok(!readdirSync(join(process.env.LEASH_HOME, 'approvals')).some((f) => f.endsWith('.tmp')));

  const old = approvals.createApproval({ ...action, now: new Date(Date.now() - 61000) });
  assert.equal(approvals.getApproval(old.id).status, 'expired');
  assert.equal(approvals.decideApproval(old.id, old.token, 'once').error, 'expired');
});

test('store: url uses LEASH_PUBLIC_URL or the first LAN IPv4 and the viewer port', () => {
  const ifaces = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false }] };
  assert.equal(approvals.approvalUrl('a_1', 't/x', { env: {}, interfaces: ifaces }), 'http://192.168.1.20:4777/a/a_1?t=t%2Fx');
  assert.equal(approvals.approvalUrl('a_1', 'tok', { env: { LEASH_VIEWER_PORT: '5000' }, interfaces: ifaces }), 'http://192.168.1.20:5000/a/a_1?t=tok');
  assert.equal(approvals.approvalUrl('a_1', 'tok', { env: { LEASH_PUBLIC_URL: 'https://leash.example/' } }), 'https://leash.example/a/a_1?t=tok');
});

test('phone decides first: dialog child is killed and the approval is marked phone', async () => {
  const dialog = fakeDialog();
  const texts = [];
  const ask = createAskAnywhere({
    dialog, phone: '+15550009999', pollMs: 10,
    sendText: async (q) => { texts.push(q); const { id, token } = parse(/http\S+/.exec(q.text)[0]); setTimeout(() => approvals.decideApproval(id, token, 'hour'), 20); return { sent: 1 }; }
  });
  const r = await ask({ action, why: 'Tell Sam I am late', message: 'Claude wants to: send', timeoutSec: 5 });
  assert.equal(r.choice, 'hour');
  assert.equal(r.decidedBy, 'phone');
  assert.equal(dialog.state.killed, true);
  assert.deepEqual(texts[0].recipients, ['+15550009999']);
  assert.match(texts[0].text, /Why \(agent's words\): "Tell Sam I am late"/);
  assert.match(texts[0].text, /\/a\/a_[0-9a-f]+\?t=/);
  assert.match(dialog.state.shown[0], /answer on your phone/);
  assert.equal(approvals.getApproval(r.approvalId).decidedBy, 'phone');
});

test('Mac decides first: approval marked mac, phone link then refused', async () => {
  const dialog = fakeDialog();
  let link;
  const ask = createAskAnywhere({ dialog, phone: '+15550009999', pollMs: 10, sendText: async (q) => { link = parse(/http\S+/.exec(q.text)[0]); return { sent: 1 }; } });
  const pending = ask({ action, why: 'Tell Sam I am late', message: 'm', timeoutSec: 5 });
  setTimeout(() => dialog.state.answer('once'), 20);
  const r = await pending;
  assert.deepEqual([r.choice, r.decidedBy], ['once', 'mac']);
  assert.equal(dialog.state.killed, false);
  const a = approvals.getApproval(r.approvalId);
  assert.deepEqual([a.status, a.choice, a.decidedBy], ['approved', 'once', 'mac']);
  assert.equal(approvals.decideApproval(link.id, link.token, 'deny').error, 'already_decided');
});

test('nobody answers: timeout denies and closes the dialog', async () => {
  const dialog = fakeDialog();
  const ask = createAskAnywhere({ dialog, phone: '', pollMs: 10 });
  const r = await ask({ action, why: 'x y z', message: 'm', timeoutSec: 0.1 });
  assert.deepEqual([r.choice, r.decidedBy], ['deny', 'timeout']);
  assert.equal(dialog.state.killed, true);
  assert.equal(approvals.getApproval(r.approvalId).status, 'denied');
});

test('phone text fails: the Mac dialog still decides and the call does not fail', async () => {
  const dialog = fakeDialog();
  const logs = [];
  const ask = createAskAnywhere({
    dialog, phone: '+15550009999', pollMs: 10, log: (m) => logs.push(m),
    sendText: async () => { const e = new Error('Messages is not signed in to iMessage'); e.fix = 'Sign in'; throw e; }
  });
  const pending = ask({ action, why: 'Tell Sam I am late', message: 'm', timeoutSec: 5 });
  setTimeout(() => dialog.state.answer('once'), 30);
  const r = await pending;
  assert.deepEqual([r.choice, r.decidedBy], ['once', 'mac']);
  assert.match(r.phoneError, /not signed in/);
  assert.ok(logs.some((l) => /phone approval text failed/.test(l)));
});

test('dialog.start kills the osascript child on cancel', async () => {
  let killed = null;
  const child = { exitCode: null, killed: false, kill(sig) { killed = sig; this.killed = true; } };
  let rejectOut;
  const h = start({ message: 'hi', spawner: () => ({ child, output: new Promise((_, rej) => { rejectOut = rej; }) }) });
  h.cancel();
  assert.equal(killed, 'SIGTERM');
  rejectOut(new Error('killed'));
  assert.equal(await h.result, 'deny');
  const ok = start({ message: 'hi', spawner: () => ({ child: null, output: Promise.resolve('Allow once\n') }) });
  assert.equal(await ok.result, 'once');
});
