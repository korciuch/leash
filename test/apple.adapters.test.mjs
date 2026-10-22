import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeOsascript } from './fixtures/fake-osascript-setup.mjs';
import { listEvents } from '../src/apple/calendar.mjs';
import { listReminders, createReminder } from '../src/apple/reminders.mjs';
import { listMessages, readMessage, sendMessage, clampLimit, normalizeAddresses } from '../src/apple/mail.mjs';
import { sendText } from '../src/apple/messages.mjs';
import { warmUp, checkPermissions, describe } from '../src/apple/preflight.mjs';
import { AppleError } from '../src/apple/jxa.mjs';

const fake = installFakeOsascript();
beforeEach(() => fake.reset());
const lastArg = () => JSON.parse(fake.calls().at(-1)[3]);

test('listEvents asks only for the named calendars and sends ISO dates', async () => {
  const events = await listEvents({ calendars: ['Leash Demo', 'Leash Demo'], from: '2026-10-26T09:00:00Z', to: new Date('2026-10-27T09:00:00Z') });
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['calendar', 'end', 'id', 'location', 'notes', 'start', 'title']);
  assert.deepEqual(lastArg(), { calendars: ['Leash Demo'], from: '2026-10-26T09:00:00.000Z', to: '2026-10-27T09:00:00.000Z' });
});

test('listEvents with no calendars runs nothing; bad dates throw', async () => {
  assert.deepEqual(await listEvents({ calendars: [] }), []);
  assert.equal(fake.calls().length, 0);
  await assert.rejects(listEvents({ calendars: ['x'], from: 'not a date' }), TypeError);
});

test('listEvents defaults to a 7 day window', async () => {
  await listEvents({ calendars: ['Leash Demo'], from: '2026-10-26T00:00:00Z' });
  assert.equal(lastArg().to, '2026-11-02T00:00:00.000Z');
});

test('reminders list and create', async () => {
  const open = await listReminders({ lists: ['Errands'] });
  assert.equal(open.length, 1);
  assert.equal(lastArg().includeCompleted, false);
  const all = await listReminders({ lists: ['Errands'], includeCompleted: true });
  assert.equal(all.length, 2);
  const made = await createReminder({ list: 'Errands', title: 'Buy stamps', notes: 'Forever stamps' });
  assert.deepEqual(made, { id: 'x-apple-reminder://new', list: 'Errands', title: 'Buy stamps' });
  assert.deepEqual(lastArg(), { list: 'Errands', title: 'Buy stamps', notes: 'Forever stamps' });
  await assert.rejects(createReminder({ list: 'Errands' }), TypeError);
});

test('mail list clamps limit and passes sinceDays', async () => {
  assert.equal(clampLimit(5000), 100);
  assert.equal(clampLimit(0), 20);
  assert.equal(clampLimit('abc'), 20);
  assert.equal(clampLimit(3.9), 3);
  const two = await listMessages({ account: 'Alumni', mailbox: 'Leash Demo', sinceDays: 30, limit: 2 });
  assert.equal(two.length, 2);
  assert.deepEqual(lastArg(), { account: 'Alumni', mailbox: 'Leash Demo', limit: 2, sinceDays: 30 });
  const all = await listMessages({ account: 'Alumni', mailbox: 'Leash Demo', limit: 9999 });
  assert.equal(all.length, 3);
  assert.equal(lastArg().limit, 100);
  assert.equal('sinceDays' in lastArg(), false);
  assert.equal(typeof all[0].id, 'string');
});

test('mail read by numeric id; not found maps to -1728', async () => {
  const msg = await readMessage({ account: 'Alumni', mailbox: 'Leash Demo', id: 1000 });
  assert.equal(msg.body, 'Body text');
  assert.equal(lastArg().id, '1000');
  await assert.rejects(readMessage({ account: 'Alumni', mailbox: 'Leash Demo', id: '1001' }), (e) => e instanceof AppleError && e.code === -1728);
  await assert.rejects(readMessage({ account: 'Alumni', mailbox: 'Leash Demo', id: 'abc' }), TypeError);
});

test('mail send normalizes recipients and refuses bad addresses', async () => {
  assert.deepEqual(normalizeAddresses('a@x.com, b@y.com;a@x.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(await sendMessage({ to: 'alex@example.com', subject: 'Re: lunch', body: 'Sounds good' }), { sent: true });
  assert.deepEqual(lastArg(), { to: ['alex@example.com'], subject: 'Re: lunch', body: 'Sounds good' });
  await assert.rejects(sendMessage({ to: 'not-an-address', subject: 's', body: 'b' }), TypeError);
  await assert.rejects(sendMessage({ to: [], subject: 's', body: 'b' }), TypeError);
});

test('messages sendText returns sent count', async () => {
  assert.deepEqual(await sendText({ recipients: ['+15551234567', 'a@icloud.com'], text: 'hi' }), { sent: 2 });
  await assert.rejects(sendText({ recipients: [], text: 'hi' }), TypeError);
  process.env.LEASH_FAKE_MODE = 'error:-1743';
  await assert.rejects(sendText({ recipients: ['+15551234567'], text: 'hi' }), (e) => e.app === 'Messages' && /Automation > node > Messages/.test(e.fix));
});

test('warmUp times each app; checkPermissions names the switch that is off', async () => {
  const warm = await warmUp();
  assert.deepEqual(warm.map((r) => r.app), ['Calendar', 'Reminders', 'Mail']);
  assert.ok(warm.every((r) => r.ok && typeof r.ms === 'number'));
  process.env.LEASH_FAKE_DENY = 'Mail,Messages';
  const perms = await checkPermissions();
  assert.deepEqual(perms.map((r) => [r.app, r.ok]), [['Calendar', true], ['Reminders', true], ['Mail', false], ['Messages', false]]);
  assert.equal(perms[2].code, -1743);
  assert.match(perms[2].fix, /Automation > node > Mail/);
  assert.match(perms[3].fix, /Automation > node > Messages/);
  const coldWarm = await warmUp(['Mail']);
  assert.equal(coldWarm[0].ok, false);
  assert.match(describe(perms), /Calendar ok/);
  await assert.rejects(warmUp(['Safari']), TypeError);
});

test('injectable runner works without osascript', async () => {
  const seen = [];
  const run = async (name, args) => { seen.push([name, args]); return [{ id: '1', calendar: 'Leash Demo' }]; };
  const events = await listEvents({ calendars: ['Leash Demo'] }, { run });
  assert.equal(events.length, 1);
  assert.equal(seen[0][0], 'calendar-events');
});
