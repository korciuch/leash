import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerPath, leashHome } from '../src/gate/paths.mjs';
import { append, readAll, tail, verify, archive } from '../src/gate/ledger.mjs';

beforeEach(() => {
  process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), 'leash-ledger-'));
});

const entry = (i) => ({ tool: 'calendar_events', app: 'calendar', verb: 'read', grantId: 'g_plan_week', decision: 'allowed', summary: `call ${i}`, records: [`e${i}`], returned: '1 event (title)' });

test('append builds a hash chain', () => {
  const a = append(entry(1));
  const b = append(entry(2));
  assert.equal(a.seq, 1);
  assert.equal(a.prev, 'genesis');
  assert.equal(a.agent, 'claude');
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(b.seq, 2);
  assert.equal(b.prev, a.hash);
  assert.equal(readAll().length, 2);
  assert.deepEqual(tail(1).map((e) => e.seq), [2]);
  assert.deepEqual(verify(), { entries: 2, intact: true });
});

test('empty ledger verifies', () => {
  assert.deepEqual(verify(), { entries: 0, intact: true });
  assert.deepEqual(readAll(), []);
});

test('verify detects a tampered line', () => {
  for (let i = 1; i <= 4; i++) append(entry(i));
  const lines = readFileSync(ledgerPath(), 'utf8').trim().split('\n');
  const e = JSON.parse(lines[2]);
  e.decision = 'denied';
  lines[2] = JSON.stringify(e);
  writeFileSync(ledgerPath(), lines.join('\n') + '\n');
  const v = verify();
  assert.equal(v.intact, false);
  assert.equal(v.brokenAt, 3);
  assert.equal(v.entries, 4);
});

test('verify detects a deleted line', () => {
  for (let i = 1; i <= 3; i++) append(entry(i));
  const lines = readFileSync(ledgerPath(), 'utf8').trim().split('\n');
  lines.splice(1, 1);
  writeFileSync(ledgerPath(), lines.join('\n') + '\n');
  assert.equal(verify().intact, false);
});

test('archive starts a fresh chain', () => {
  append(entry(1));
  append(entry(2));
  const { archivedTo } = archive();
  assert.ok(archivedTo && existsSync(archivedTo));
  assert.match(archivedTo, /ledger\..+\.jsonl$/);
  assert.equal(existsSync(ledgerPath()), false);
  const first = append(entry(3));
  assert.equal(first.seq, 1);
  assert.equal(first.prev, 'genesis');
  assert.deepEqual(verify(), { entries: 1, intact: true });
  assert.equal(readdirSync(leashHome()).filter((f) => /^ledger\..+\.jsonl$/.test(f)).length, 1);
  assert.deepEqual(archive().archivedTo !== null, true);
  assert.deepEqual(archive(), { archivedTo: null });
});
