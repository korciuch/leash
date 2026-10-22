import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, mapReply, DIALOG_SCRIPT } from '../src/consent/dialog.mjs';
import { verify } from '../src/consent/touchid.mjs';

test('dialog maps buttons to choices and passes the message as argv', async () => {
  const seen = [];
  const runner = (out) => async (args) => { seen.push(args); return out + '\n'; };
  assert.equal(await ask({ message: 'hi', runner: runner('Allow once') }), 'once');
  assert.equal(await ask({ message: 'hi', runner: runner('Allow for 1 hour') }), 'hour');
  assert.equal(await ask({ message: 'hi', runner: runner('Deny') }), 'deny');
  assert.equal(await ask({ message: 'hi', runner: runner('Deny (timed out)') }), 'deny');
  assert.equal(await ask({ message: 'hi', runner: runner('Deny (closed)') }), 'deny');
  assert.equal(await ask({ message: 'x', runner: async () => { throw new Error('osascript missing'); } }), 'deny');
  assert.deepEqual(seen[0], ['hi', '60']);
  assert.equal(mapReply('garbage'), 'deny');
  assert.ok(DIALOG_SCRIPT.includes("defaultButton: 'Deny'"));
  assert.ok(!DIALOG_SCRIPT.includes('hi'));
});

test('dialog truncates very long messages', async () => {
  let got;
  await ask({ message: 'a'.repeat(5000), runner: async (args) => { got = args[0]; return 'Deny'; } });
  assert.ok(got.length <= 900);
});

test('touchid maps helper exit codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leash-tid-'));
  const make = (code) => {
    const file = join(dir, `helper-${code}.sh`);
    writeFileSync(file, `#!/bin/sh\necho "reason: $1"\nexit ${code}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const ok = await verify('send an email as you to a@b.c: Hi', { helper: make(0) });
  assert.equal(ok.approved, true);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /send an email as you to a@b.c: Hi/);
  assert.deepEqual([(await verify('x', { helper: make(1) })).approved, (await verify('x', { helper: make(1) })).code], [false, 1]);
  assert.equal((await verify('x', { helper: make(2) })).code, 2);
  const missing = await verify('x', { helper: join(dir, 'nope') });
  assert.equal(missing.approved, false);
  assert.equal(missing.code, 2);
});

test('touchid uses LEASH_TOUCHID by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leash-tid-'));
  const file = join(dir, 'Leash');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  process.env.LEASH_TOUCHID = file;
  try {
    assert.equal((await verify('x')).approved, true);
  } finally {
    delete process.env.LEASH_TOUCHID;
  }
});

test('drafts are file backed in LEASH_HOME', async () => {
  process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), 'leash-drafts-'));
  const drafts = await import('../src/drafts.mjs');
  const d = drafts.createDraft({ to: 'a@b.c', subject: 'S', body: 'B', inReplyTo: '12' });
  assert.match(d.id, /^d_/);
  assert.equal(drafts.getDraft(d.id).subject, 'S');
  assert.equal(drafts.listDrafts().length, 1);
  assert.ok(drafts.markSent(d.id).sentAt);
  assert.ok(drafts.getDraft(d.id).sentAt);
  drafts.clearDrafts();
  assert.equal(drafts.listDrafts().length, 0);
  assert.equal(drafts.getDraft('nope'), null);
});
