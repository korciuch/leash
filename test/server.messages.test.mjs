// Messages send script on JXA stubs, and the adapter's error mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sendText, NO_IMESSAGE_FIX } from '../src/apple/messages.mjs';
import { AppleError, SCRIPTS_DIR } from '../src/apple/jxa.mjs';

const src = readFileSync(new URL('messages-send.js', 'file://' + SCRIPTS_DIR), 'utf8');
function runWith(Messages, args) {
  const ctx = { Application: () => Messages, JSON };
  vm.runInNewContext(src, ctx);
  return JSON.parse(ctx.run([JSON.stringify(args)]));
}
const ref = (ok = true) => ({ exists: () => ok });

test('script: no iMessage account gives the no_imessage error', () => {
  const none = { accounts: () => [{ serviceType: () => 'SMS', enabled: () => true }] };
  const out = runWith(none, { recipients: ['+15550001'], text: 'hi' });
  assert.deepEqual(out.error, { app: 'Messages', code: 'no_imessage', message: NO_IMESSAGE_FIX });
  const disabled = { services: () => [{ serviceType: () => 'iMessage', enabled: () => false }] };
  assert.equal(runWith(disabled, { recipients: ['+15550001'], text: 'hi' }).error.code, 'no_imessage');
});

test('script: finds the iMessage account via accounts() or services() and sends', () => {
  const sent = [];
  const account = { id: () => 'ACC1', serviceType: () => 'iMessage', enabled: () => true, participants: { byName: (h) => ({ ...ref(h !== '+1nobody'), h }) } };
  const viaAccounts = { accounts: Object.assign(() => [account], { byId: () => account }), send: (body, opts) => sent.push([body, opts.to.h]) };
  assert.deepEqual(runWith(viaAccounts, { recipients: ['+15550001', '+1nobody'], text: 'hi' }), { sent: 2, failed: [] });
  assert.deepEqual(sent.map((s) => s[1]), ['+15550001', '+1nobody']);

  const svc = { id: () => 'S1', serviceType: () => 'iMessage', buddies: { byName: (h) => ({ ...ref(), h }) } };
  const sent2 = [];
  const viaServices = { accounts: () => { throw new Error('no accounts'); }, services: () => [svc], send: (b, o) => sent2.push(o.to.h) };
  assert.deepEqual(runWith(viaServices, { recipients: ['a@icloud.com'], text: 'hi' }), { sent: 1, failed: [] });
  assert.deepEqual(sent2, ['a@icloud.com']);
});

test('adapter: no_imessage maps to the exact fix with no generic -1728 text', async () => {
  const run = async () => { throw new AppleError({ app: 'Messages', code: null, message: NO_IMESSAGE_FIX }); };
  await assert.rejects(sendText({ recipients: ['+15550001'], text: 'hi' }, { run }), (e) => {
    assert.equal(e.code, 'no_imessage');
    assert.equal(e.fix, NO_IMESSAGE_FIX);
    assert.doesNotMatch(e.fix, /calendar, list or mailbox/);
    return true;
  });
  const notSent = async () => { throw new AppleError({ app: 'Messages', code: -1728, message: 'No text was sent. Could not send to +1' }); };
  await assert.rejects(sendText({ recipients: ['+1'], text: 'hi' }, { run: notSent }), (e) => !/mailbox/.test(e.fix));
});
