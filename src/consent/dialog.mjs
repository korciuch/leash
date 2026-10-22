// Native approval dialog (from docs/spike-02-approval-dialog.js).
// The script is fixed text; the message and timeout travel as argv, never spliced into code.
import { execFile } from 'node:child_process';

export const DIALOG_SCRIPT = [
  'function run(argv) {',
  '  const app = Application.currentApplication();',
  '  app.includeStandardAdditions = true;',
  '  app.activate();',
  '  try {',
  "    const r = app.displayDialog(argv[0], { withTitle: 'Leash', buttons: ['Deny', 'Allow once', 'Allow for 1 hour'], defaultButton: 'Deny', withIcon: 'caution', givingUpAfter: Number(argv[1]) || 60 });",
  "    return r.gaveUp ? 'Deny (timed out)' : r.buttonReturned;",
  "  } catch (e) { return 'Deny (closed)'; }",
  '}'
].join('\n');

const MAX_MESSAGE = 900;

/**
 * Default runner: osascript with the fixed script.
 * @param {string[]} args argv for the script: [message, timeoutSec]
 * @param {{ timeoutMs: number }} opts
 * @returns {Promise<string>} stdout
 */
export function defaultRunner(args, { timeoutMs }) {
  const osascript = process.env.LEASH_DIALOG_OSASCRIPT || '/usr/bin/osascript';
  return new Promise((resolve, reject) => {
    execFile(osascript, ['-l', 'JavaScript', '-e', DIALOG_SCRIPT, ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * Map the button text to a choice. Anything unexpected is a deny.
 * @param {string} output
 * @returns {'deny'|'once'|'hour'}
 */
export function mapReply(output) {
  const text = String(output || '').trim();
  if (text === 'Allow once') return 'once';
  if (text === 'Allow for 1 hour') return 'hour';
  return 'deny';
}

/**
 * Show the approval dialog. Timeout, close, or any failure means deny.
 * @param {{ message: string, timeoutSec?: number, runner?: Function }} opts
 * @returns {Promise<'deny'|'once'|'hour'>}
 */
export async function ask({ message, timeoutSec = 60, runner = defaultRunner }) {
  let text = String(message || '');
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE - 3) + '...';
  try {
    const output = await runner([text, String(timeoutSec)], { timeoutMs: (timeoutSec + 15) * 1000 });
    return mapReply(output);
  } catch {
    return 'deny';
  }
}
