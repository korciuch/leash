import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { SCRIPTS_DIR, SCRIPT_APPS } from '../src/apple/jxa.mjs';

const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.js'));

test('every known script exists and every file is known', () => {
  assert.deepEqual(files.map((f) => f.slice(0, -3)).sort(), Object.keys(SCRIPT_APPS).sort());
});

for (const file of files) {
  test(`${file}: valid JS with run(argv), one JSON arg, no string-built code`, () => {
    const full = path.join(SCRIPTS_DIR, file);
    execFileSync(process.execPath, ['--check', full]);
    const src = readFileSync(full, 'utf8');
    assert.match(src, /^function run\(argv\) \{/m);
    assert.match(src, /JSON\.parse\(argv\[0\] \|\| '\{\}'\)/);
    assert.doesNotMatch(src, /\beval\(|new Function\(|doShellScript/);
    assert.ok(!src.includes(String.fromCharCode(0x2014)), 'no em dash');
  });
}

test('calendar script never iterates all calendars', () => {
  const src = readFileSync(path.join(SCRIPTS_DIR, 'calendar-events.js'), 'utf8');
  assert.match(src, /calendars\.byName\(/);
  assert.doesNotMatch(src, /calendars\(\)/);
});

test('scripts run in plain node with stubbed JXA globals', () => {
  // Minimal stub of Application() so the run() logic is exercised on Linux.
  const day = 864e5;
  const now = Date.now();
  const bulk = (values) => { const f = () => values.map((v, i) => ({ id: () => v.id })); return f; };
  const messages = [0, 1, 2].map((i) => ({ id: 500 + i, date: new Date(now - i * 20 * day), sender: 'a@x.com', subject: 's' + i, read: i === 0 }));
  const range = (n) => Object.assign(bulk(messages.slice(0, n)), {
    id: () => messages.slice(0, n).map((m) => m.id),
    dateReceived: () => messages.slice(0, n).map((m) => m.date),
    sender: () => messages.slice(0, n).map((m) => m.sender),
    subject: () => messages.slice(0, n).map((m) => m.subject),
    readStatus: () => messages.slice(0, n).map((m) => m.read)
  });
  const box = { exists: () => true, messages: { length: messages.length, slice: (a, b) => { if (b >= messages.length) { const e = new Error('Invalid index'); e.errorNumber = -1719; throw e; } return range(b + 1); } } };
  globalThis.Application = (name) => {
    if (name !== 'Mail') { const e = new Error('Not authorized (-1743)'); e.errorNumber = -1743; throw e; }
    return { accounts: { byName: (n) => ({ exists: () => n === 'Alumni', mailboxes: { byName: () => box } }) } };
  };
  try {
    const src = readFileSync(path.join(SCRIPTS_DIR, 'mail-list.js'), 'utf8');
    const run = new Function(src + '\nreturn run;')();
    const big = JSON.parse(run([JSON.stringify({ account: 'Alumni', mailbox: 'Leash Demo', limit: 50 })]));
    assert.equal(big.length, 3);
    const recent = JSON.parse(run([JSON.stringify({ account: 'Alumni', mailbox: 'Leash Demo', limit: 50, sinceDays: 30 })]));
    assert.deepEqual(recent.map((m) => m.id), ['500', '501']);
    const missing = JSON.parse(run([JSON.stringify({ account: 'Nope', mailbox: 'Leash Demo' })]));
    assert.equal(missing.error.code, -1728);
    const ping = new Function(readFileSync(path.join(SCRIPTS_DIR, 'ping.js'), 'utf8') + '\nreturn run;')();
    assert.equal(JSON.parse(ping([JSON.stringify({ app: 'Calendar' })])).error.code, -1743);
    assert.match(JSON.parse(ping([JSON.stringify({ app: 'Safari' })])).error.message, /only talks to/);
  } finally {
    delete globalThis.Application;
  }
});
