// A macOS Notification Center banner when Leash blocks something. Fire and forget: never fails a call.
import { execFile } from 'node:child_process';

const SCRIPT = "function run(argv) { const app = Application.currentApplication(); app.includeStandardAdditions = true; app.displayNotification(argv[2] || '', { withTitle: argv[0] || 'Leash', subtitle: argv[1] || '', soundName: 'Funk' }); }";

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** @param {{ title?: string, subtitle?: string, body?: string }} note */
export function notify({ title = 'Leash blocked a request', subtitle = '', body = '' } = {}, { osascript = process.env.LEASH_OSASCRIPT || '/usr/bin/osascript' } = {}) {
  if (process.env.LEASH_NOTIFY === '0') return;
  try {
    const child = execFile(osascript, ['-l', 'JavaScript', '-e', SCRIPT, clip(title, 60), clip(subtitle, 90), clip(body, 160)], { timeout: 10000 }, () => {});
    child.on('error', () => {});
  } catch {}
}
