import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedGrants } from '../src/gate/grants.mjs';
import { decide } from '../src/gate/policy.mjs';
import { filterEvents, filterReminders, filterMessages } from '../src/gate/filter.mjs';

const NOW = new Date('2026-10-22T14:00:00.000Z');
const at = (h) => new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), 'leash-filter-'));
});

test('filterEvents keeps granted calendar and window, withholds notes and location', () => {
  const [plan] = seedGrants(NOW);
  const { clamp } = decide({ tool: 'calendar_events', app: 'calendar', verb: 'read', target: {}, summary: '' }, [plan], NOW);
  const events = [
    { id: 'e1', calendar: 'Leash Demo', title: 'Standup', start: at(20), end: at(20.5), location: 'Room 4', notes: 'Door code 4417' },
    { id: 'e2', calendar: 'Leash Demo', title: 'Review', start: at(48), end: at(49), location: '', notes: 'PIN 9921' },
    { id: 'e3', calendar: 'Leash Demo', title: 'Old', start: at(-30), end: at(-29), notes: 'x' },
    { id: 'e4', calendar: 'Leash Demo', title: 'Far', start: at(24 * 9), end: at(24 * 9 + 1) },
    { id: 'e5', calendar: 'Leash Personal', title: 'Doctor', start: at(5), end: at(6), notes: 'private' },
    { id: 'e6', calendar: 'Leash Demo', title: 'In progress', start: at(-1), end: at(1) },
  ];
  const { items, hidden } = filterEvents(events, plan, clamp, NOW);
  assert.deepEqual(items.map((e) => e.id), ['e1', 'e2', 'e6']);
  for (const e of items) {
    assert.deepEqual(Object.keys(e).sort(), ['calendar', 'end', 'id', 'start', 'title']);
    assert.equal('notes' in e, false);
    assert.equal('location' in e, false);
  }
  assert.equal(hidden.records, 3);
  assert.deepEqual(hidden.fields, ['location', 'notes']);
  assert.equal(JSON.stringify(items).includes('4417'), false);
});

test('filterEvents with no grant hides everything', () => {
  const r = filterEvents([{ id: 'a', calendar: 'Leash Demo', start: at(1), end: at(2) }], null, {}, NOW);
  assert.deepEqual(r, { items: [], hidden: { records: 1, fields: [] } });
});

test('filterReminders keeps granted lists', () => {
  const errands = seedGrants(NOW)[2];
  const { items, hidden } = filterReminders([
    { id: 'r1', list: 'Errands', title: 'Milk', notes: 'oat', completed: false, due: null },
    { id: 'r2', list: 'Work', title: 'Secret', notes: '', completed: false, due: null },
  ], errands);
  assert.deepEqual(items.map((r) => r.id), ['r1']);
  assert.equal(items[0].notes, 'oat');
  assert.deepEqual(hidden, { records: 1, fields: [] });
});

test('filterMessages keeps granted mailbox and sinceDays, withholds to', () => {
  const mail = seedGrants(NOW)[1];
  const d = (days) => new Date(NOW.getTime() - days * 86400000).toISOString();
  const { items, hidden } = filterMessages([
    { id: 'm1', account: 'Alumni', mailbox: 'Leash Demo', from: 'a@x', to: 'me@x', subject: 'Hi', date: d(2), body: 'hello', read: false },
    { id: 'm2', account: 'Alumni', mailbox: 'INBOX', from: 'b@x', subject: 'Bank', date: d(1), body: 'acct' },
    { id: 'm3', account: 'Alumni', mailbox: 'Leash Demo', from: 'c@x', subject: 'Old', date: d(45), body: 'old' },
  ], mail, NOW);
  assert.deepEqual(items.map((m) => m.id), ['m1']);
  assert.equal('to' in items[0], false);
  assert.equal(items[0].body, 'hello');
  assert.deepEqual(hidden, { records: 2, fields: ['to'] });
});
