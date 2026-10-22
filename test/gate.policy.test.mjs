import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGrants, revokeGrant, addGrant, seedGrants } from '../src/gate/grants.mjs';
import { decide, tierOf, grantFromApproval } from '../src/gate/policy.mjs';

const NOW = new Date('2026-10-22T14:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), 'leash-policy-'));
});

const calRead = (target = {}) => ({ tool: 'calendar_events', app: 'calendar', verb: 'read', target, summary: 'Read calendar events' });

test('tierOf', () => {
  assert.deepEqual(['read', 'create', 'draft', 'modify', 'send', 'delete'].map(tierOf), [0, 1, 1, 2, 3, 3]);
});

test('calendar read is allowed and clamped to the grant calendars and window', () => {
  const d = decide(calRead(), seedGrants(NOW), NOW);
  assert.equal(d.outcome, 'allow');
  assert.equal(d.grant.id, 'g_plan_week');
  assert.deepEqual(d.clamp.calendars, ['Leash Demo']);
  assert.equal(d.clamp.from, NOW.toISOString());
  assert.equal(d.clamp.to, new Date(NOW.getTime() + 7 * DAY).toISOString());
});

test('requested range is intersected with the window', () => {
  const d = decide(calRead({ calendars: ['Leash Demo'], from: '2026-10-01T00:00:00Z', to: '2026-10-24T00:00:00Z' }), seedGrants(NOW), NOW);
  assert.equal(d.outcome, 'allow');
  assert.equal(d.clamp.from, NOW.toISOString());
  assert.equal(d.clamp.to, '2026-10-24T00:00:00.000Z');
  const wide = decide(calRead({ to: '2027-01-01T00:00:00Z' }), seedGrants(NOW), NOW);
  assert.equal(wide.clamp.to, new Date(NOW.getTime() + 7 * DAY).toISOString());
  const past = decide(calRead({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }), seedGrants(NOW), NOW);
  assert.equal(past.outcome, 'ask');
});

test('Leash Personal is not covered', () => {
  const d = decide(calRead({ calendars: ['Leash Personal'] }), seedGrants(NOW), NOW);
  assert.equal(d.outcome, 'ask');
  assert.match(d.reason, /Plan the week/);
  const mixed = decide(calRead({ calendars: ['Leash Demo', 'Leash Personal'] }), seedGrants(NOW), NOW);
  assert.equal(mixed.outcome, 'ask');
});

test('expired grant blocks the next call', () => {
  const grants = seedGrants(NOW);
  assert.equal(decide(calRead(), grants, new Date(NOW.getTime() + 59 * 60 * 1000)).outcome, 'allow');
  const d = decide(calRead(), grants, new Date(NOW.getTime() + HOUR + 1000));
  assert.equal(d.outcome, 'ask');
  assert.match(d.reason, /expired/);
});

test('revoked grant blocks (store round trip)', () => {
  const now = new Date();
  assert.equal(decide(calRead(), loadGrants(), now).outcome, 'allow');
  revokeGrant('g_plan_week', 'viewer');
  const d = decide(calRead(), loadGrants(), now);
  assert.equal(d.outcome, 'ask');
  assert.match(d.reason, /revoked/);
});

test('mail send inside Draft replies needs Touch ID', () => {
  const d = decide({ tool: 'mail_send', app: 'mail', verb: 'send', target: { recipients: ['ana@example.com'] }, summary: 'Send an email' }, seedGrants(NOW), NOW);
  assert.equal(d.outcome, 'touchid');
  assert.equal(d.grant.id, 'g_draft_replies');
});

test('mail draft is allowed, mail read clamps to the granted mailbox', () => {
  const g = seedGrants(NOW);
  assert.equal(decide({ tool: 'mail_draft', app: 'mail', verb: 'draft', target: { recipients: ['a@b.c'] }, summary: '' }, g, NOW).outcome, 'allow');
  const r = decide({ tool: 'mail_list', app: 'mail', verb: 'read', target: {}, summary: '' }, g, NOW);
  assert.equal(r.outcome, 'allow');
  assert.deepEqual(r.clamp.mailboxes, [{ account: 'Alumni', mailbox: 'Leash Demo' }]);
  assert.equal(r.clamp.sinceDays, 30);
  const inbox = decide({ tool: 'mail_list', app: 'mail', verb: 'read', target: { account: 'Alumni', mailbox: 'INBOX' }, summary: '' }, g, NOW);
  assert.equal(inbox.outcome, 'ask');
});

test('messages send asks', () => {
  const d = decide({ tool: 'messages_send', app: 'messages', verb: 'send', target: { recipients: ['+15550001', '+15550002'] }, summary: 'Send a text' }, seedGrants(NOW), NOW);
  assert.equal(d.outcome, 'ask');
  assert.equal(d.reason, 'No grant covers Messages');
});

test('reminders: granted list allowed, other list asks, delete asks', () => {
  const g = seedGrants(NOW);
  const ok = decide({ tool: 'reminders_add', app: 'reminders', verb: 'create', target: { list: 'Errands' }, summary: '' }, g, NOW);
  assert.equal(ok.outcome, 'allow');
  assert.deepEqual(ok.clamp.lists, ['Errands']);
  assert.equal(decide({ tool: 'reminders_list', app: 'reminders', verb: 'read', target: { list: 'Work' }, summary: '' }, g, NOW).outcome, 'ask');
  assert.equal(decide({ tool: 'x', app: 'reminders', verb: 'delete', target: { list: 'Errands' }, summary: '' }, g, NOW).outcome, 'ask');
});

test('unknown app is denied', () => {
  assert.equal(decide({ tool: 'x', app: 'photos', verb: 'read', target: {}, summary: '' }, seedGrants(NOW), NOW).outcome, 'deny');
});

test('grantFromApproval scopes to the action and covers a repeat call', () => {
  const action = { tool: 'messages_send', app: 'messages', verb: 'send', target: { recipients: ['+15550001'] }, summary: 'Send a text to 1 contact' };
  assert.equal(grantFromApproval(action, 'once', NOW), null);
  assert.equal(grantFromApproval(action, 'deny', NOW), null);
  const g = grantFromApproval(action, 'hour', NOW);
  assert.equal(g.source, 'dialog');
  assert.deepEqual(g.verbs, ['send']);
  assert.deepEqual(g.records.recipients, ['+15550001']);
  assert.equal(g.expiresAt, new Date(NOW.getTime() + HOUR).toISOString());
  const grants = [...seedGrants(NOW), g];
  assert.equal(decide(action, grants, NOW).outcome, 'touchid');
  const other = { ...action, target: { recipients: ['+15550009'] } };
  assert.equal(decide(other, grants, NOW).outcome, 'ask');

  const cal = calRead({ calendars: ['Leash Personal'], to: new Date(NOW.getTime() + 2 * DAY).toISOString() });
  const cg = addGrant(grantFromApproval(cal, 'hour', NOW));
  assert.deepEqual(cg.records, { calendars: ['Leash Personal'], windowDays: 2 });
  assert.equal(decide(cal, [cg], NOW).outcome, 'allow');
});
