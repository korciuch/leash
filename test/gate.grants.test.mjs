import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantsPath, leashHome, ledgerPath, draftsPath } from '../src/gate/paths.mjs';
import { loadGrants, activeGrants, addGrant, revokeGrant, resetToSeed, seedGrants } from '../src/gate/grants.mjs';

beforeEach(() => {
  process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), 'leash-grants-'));
  for (const k of ['LEASH_CALENDAR', 'LEASH_MAIL_ACCOUNT', 'LEASH_MAIL_MAILBOX', 'LEASH_ERRANDS']) delete process.env[k];
});

test('paths follow LEASH_HOME at call time', () => {
  const home = leashHome();
  assert.equal(grantsPath(), join(home, 'grants.json'));
  assert.equal(ledgerPath(), join(home, 'ledger.jsonl'));
  assert.equal(draftsPath(), join(home, 'drafts.json'));
});

test('loadGrants seeds the file with the three demo grants', () => {
  assert.equal(existsSync(grantsPath()), false);
  const grants = loadGrants();
  assert.deepEqual(grants.map((g) => g.id), ['g_plan_week', 'g_draft_replies', 'g_errands']);
  const onDisk = JSON.parse(readFileSync(grantsPath(), 'utf8'));
  assert.equal(onDisk.grants.length, 3);
  const errands = grants.find((g) => g.id === 'g_errands');
  assert.equal(errands.expiresAt, null);
  assert.deepEqual(errands.records.lists, ['Errands']);
  assert.equal(readdirSync(leashHome()).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('seed names come from env', () => {
  process.env.LEASH_CALENDAR = 'Work';
  process.env.LEASH_MAIL_ACCOUNT = 'Gmail';
  process.env.LEASH_MAIL_MAILBOX = 'Demo';
  process.env.LEASH_ERRANDS = 'Shopping';
  const [cal, mail, rem] = seedGrants(new Date('2026-10-22T12:00:00Z'));
  assert.deepEqual(cal.records.calendars, ['Work']);
  assert.deepEqual(mail.records.mailboxes, [{ account: 'Gmail', mailbox: 'Demo' }]);
  assert.deepEqual(rem.records.lists, ['Shopping']);
  assert.equal(cal.expiresAt, '2026-10-22T13:00:00.000Z');
});

test('addGrant fills id and createdAt and persists', () => {
  const g = addGrant({ name: 'Test', app: 'calendar', verbs: ['read'], records: { calendars: ['X'], windowDays: 1 }, fields: ['title'], expiresAt: null, source: 'cli' });
  assert.match(g.id, /^g_[0-9a-f]{6}$/);
  assert.ok(g.createdAt);
  assert.ok(loadGrants().some((x) => x.id === g.id));
});

test('revokeGrant marks the grant and removes it from activeGrants', () => {
  loadGrants();
  const r = revokeGrant('g_errands', 'viewer');
  assert.ok(r.revokedAt);
  assert.equal(activeGrants().some((g) => g.id === 'g_errands'), false);
  assert.equal(revokeGrant('nope'), null);
});

test('activeGrants drops expired grants; resetToSeed restores them', () => {
  loadGrants();
  const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
  assert.deepEqual(activeGrants(later).map((g) => g.id), ['g_errands']);
  revokeGrant('g_errands');
  const fresh = resetToSeed(later);
  assert.equal(fresh.length, 3);
  assert.equal(activeGrants(later).length, 3);
});
