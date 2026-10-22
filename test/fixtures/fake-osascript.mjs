#!/usr/bin/env node
// Fake /usr/bin/osascript for Linux tests. Called as: fake-osascript -l JavaScript <script.js> <json>
// Dispatches on the script file name and prints canned JSON.
// Env knobs:
//   LEASH_FAKE_LOG=<file>      append {argv} as one JSON line per call
//   LEASH_FAKE_MODE=ok | error:<code> | stderr:<code> | hang | garbage | empty
//   LEASH_FAKE_DENY=Mail,Messages   ping for these apps fails with -1743
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
// node --test globs everything under test/, so a bare run (no args) is a quiet no-op.
if (argv.length === 0) process.exit(0);
if (process.env.LEASH_FAKE_LOG) appendFileSync(process.env.LEASH_FAKE_LOG, JSON.stringify({ argv }) + '\n');

if (argv[0] !== '-l' || argv[1] !== 'JavaScript' || !argv[2]) {
  process.stderr.write('usage: osascript -l JavaScript <file> <arg>\n');
  process.exit(1);
}
const name = path.basename(argv[2], '.js');
const args = JSON.parse(argv[3] || '{}');
const mode = process.env.LEASH_FAKE_MODE || 'ok';
const APPS = { 'calendar-events': 'Calendar', 'reminders-list': 'Reminders', 'reminders-create': 'Reminders', 'mail-list': 'Mail', 'mail-read': 'Mail', 'mail-send': 'Mail', 'messages-send': 'Messages', ping: args.app };
const app = APPS[name] || 'Unknown';
const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');

if (mode === 'hang') {
  setTimeout(() => print({ late: true }), 60000);
} else if (mode === 'garbage') {
  process.stdout.write('this is not json\n');
} else if (mode === 'empty') {
  process.stdout.write('');
} else if (mode.startsWith('error:')) {
  print({ error: { app, code: Number(mode.slice(6)), message: `${app} got an error: fake (${mode.slice(6)})` } });
} else if (mode.startsWith('stderr:')) {
  process.stderr.write(`${argv[2]}: execution error: Error: ${app} got an error: fake failure. (${mode.slice(7)})\n`);
  process.exit(1);
} else {
  print(canned(name, args));
}

function canned(script, a) {
  const deny = (process.env.LEASH_FAKE_DENY || '').split(',').filter(Boolean);
  switch (script) {
    case 'ping':
      if (deny.includes(a.app)) return { error: { app: a.app, code: -1743, message: `Not authorized to send Apple events to ${a.app}. (-1743)` } };
      return { app: a.app, ok: true, count: 2, ms: 5 };
    case 'calendar-events':
      return (a.calendars || []).flatMap((calendar, i) => [
        { id: `ev-${i}-1`, calendar, title: 'Weekly planning', start: a.from, end: a.to, location: 'Zoom', notes: 'Office door code 4471.' }
      ]);
    case 'reminders-list':
      return (a.lists || []).flatMap((list) => [
        { id: 'x-apple-reminder://1', list, title: 'Pick up dry cleaning', notes: 'Ticket 2214.', completed: false, due: null },
        ...(a.includeCompleted ? [{ id: 'x-apple-reminder://2', list, title: 'Old', notes: null, completed: true, due: null }] : [])
      ]);
    case 'reminders-create':
      return { id: 'x-apple-reminder://new', list: a.list, title: a.title };
    case 'mail-list': {
      const count = 3;
      const n = Math.min(count, a.limit || 20);
      return Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), account: a.account, mailbox: a.mailbox, from: 'Alex <alex@example.com>', subject: `Hello ${i}`, date: new Date(Date.now() - i * 864e5).toISOString(), read: false }));
    }
    case 'mail-read':
      if (a.id !== '1000') return { error: { app: 'Mail', code: -1728, message: `Message not found: ${a.id}` } };
      return { id: a.id, account: a.account, mailbox: a.mailbox, from: 'Alex <alex@example.com>', to: 'kyle@example.com', subject: 'Hello 0', date: new Date().toISOString(), body: 'Body text' };
    case 'mail-send':
      return { sent: true, to: (a.to || []).length };
    case 'messages-send':
      return { sent: (a.recipients || []).length, failed: [] };
    default:
      return { error: { app: 'Unknown', code: null, message: `fake osascript has no canned reply for ${script}` } };
  }
}
