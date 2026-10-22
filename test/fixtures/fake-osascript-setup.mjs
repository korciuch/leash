// Test helper: copies the fake osascript to a temp dir (the repo mount may drop exec bits),
// makes it executable and points LEASH_OSASCRIPT at it.
import { copyFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./fake-osascript.mjs', import.meta.url));

export function installFakeOsascript() {
  const dir = mkdtempSync(path.join(tmpdir(), 'leash-fake-osa-'));
  const bin = path.join(dir, 'osascript');
  copyFileSync(source, bin);
  chmodSync(bin, 0o755);
  const log = path.join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  process.env.LEASH_OSASCRIPT = bin;
  process.env.LEASH_FAKE_LOG = log;
  delete process.env.LEASH_FAKE_MODE;
  delete process.env.LEASH_FAKE_DENY;
  return {
    dir,
    bin,
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).argv);
    },
    reset() {
      writeFileSync(log, '');
      delete process.env.LEASH_FAKE_MODE;
      delete process.env.LEASH_FAKE_DENY;
    }
  };
}
