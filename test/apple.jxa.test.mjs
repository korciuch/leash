import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { installFakeOsascript } from './fixtures/fake-osascript-setup.mjs';
import { runScript, AppleError, fixFor, codeFromText, scriptPath, SCRIPTS_DIR } from '../src/apple/jxa.mjs';

const fake = installFakeOsascript();
beforeEach(() => fake.reset());

test('passes -l JavaScript, the fixed script path and one JSON arg', async () => {
  const args = { calendars: ['Leash Demo', 'Quote " and ; rm -rf ~'], from: '2026-10-26T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' };
  const result = await runScript('calendar-events', args);
  assert.equal(result.length, 2);
  const [argv] = fake.calls();
  assert.equal(argv.length, 4);
  assert.deepEqual(argv.slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(argv[2], path.join(SCRIPTS_DIR, 'calendar-events.js'));
  assert.deepEqual(JSON.parse(argv[3]), args);
});

test('unknown script names are refused before anything runs', async () => {
  await assert.rejects(runScript('../../evil', {}), AppleError);
  assert.throws(() => scriptPath('nope'), AppleError);
  assert.equal(fake.calls().length, 0);
});

test('script-reported -1743 becomes AppleError with the Automation fix', async () => {
  process.env.LEASH_FAKE_MODE = 'error:-1743';
  await assert.rejects(runScript('calendar-events', { calendars: ['x'] }), (e) => {
    assert.ok(e instanceof AppleError);
    assert.equal(e.code, -1743);
    assert.equal(e.app, 'Calendar');
    assert.match(e.fix, /System Settings > Privacy & Security > Automation > node > Calendar/);
    return true;
  });
});

for (const [code, pattern] of [[-1712, /too long/], [-1728, /calendar, list or mailbox name/], [-1719, /does not exist/], [-600, /not running/]]) {
  test(`maps ${code} to a plain fix`, async () => {
    process.env.LEASH_FAKE_MODE = `error:${code}`;
    await assert.rejects(runScript('mail-list', { account: 'Alumni', mailbox: 'x' }), (e) => {
      assert.equal(e.code, code);
      assert.equal(e.app, 'Mail');
      assert.match(e.fix, pattern);
      return true;
    });
  });
}

test('osascript exiting non-zero: code parsed from stderr', async () => {
  process.env.LEASH_FAKE_MODE = 'stderr:-1743';
  await assert.rejects(runScript('reminders-list', { lists: ['Errands'] }), (e) => {
    assert.equal(e.code, -1743);
    assert.equal(e.app, 'Reminders');
    assert.match(e.fix, /Automation > node > Reminders/);
    return true;
  });
});

test('timeout kills osascript and reports -1712', async () => {
  process.env.LEASH_FAKE_MODE = 'hang';
  const started = Date.now();
  await assert.rejects(runScript('mail-list', { account: 'a', mailbox: 'b' }, { timeoutMs: 400 }), (e) => {
    assert.equal(e.code, -1712);
    assert.match(e.message, /did not answer/);
    return true;
  });
  assert.ok(Date.now() - started < 5000);
});

test('non-JSON and empty output are errors, not crashes', async () => {
  process.env.LEASH_FAKE_MODE = 'garbage';
  await assert.rejects(runScript('ping', { app: 'Mail' }), /not JSON/);
  process.env.LEASH_FAKE_MODE = 'empty';
  await assert.rejects(runScript('ping', { app: 'Mail' }), /not JSON/);
});

test('missing osascript binary is a clear error', async () => {
  const saved = process.env.LEASH_OSASCRIPT;
  process.env.LEASH_OSASCRIPT = path.join(fake.dir, 'does-not-exist');
  try {
    await assert.rejects(runScript('ping', { app: 'Mail' }), /osascript not found/);
  } finally {
    process.env.LEASH_OSASCRIPT = saved;
  }
});

test('codeFromText and fixFor', () => {
  assert.equal(codeFromText('execution error: Not authorized to send Apple events to Mail. (-1743)'), -1743);
  assert.equal(codeFromText('nothing here'), null);
  assert.match(fixFor(-1743, 'Messages'), /Automation > node > Messages/);
  assert.equal(new AppleError({ app: 'Mail', code: -600, message: 'x' }).toJSON().code, -600);
});
