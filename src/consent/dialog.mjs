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
 * Default spawner: like defaultRunner but hands back the ChildProcess so the caller can kill it.
 * @param {string[]} args
 * @param {{ timeoutMs: number }} opts
 * @returns {{ child: import('node:child_process').ChildProcess, output: Promise<string> }}
 */
export function defaultSpawner(args, { timeoutMs }) {
  const osascript = process.env.LEASH_DIALOG_OSASCRIPT || '/usr/bin/osascript';
  let child;
  const output = new Promise((resolve, reject) => {
    child = execFile(osascript, ['-l', 'JavaScript', '-e', DIALOG_SCRIPT, ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
  return { child, output };
}

const clip = (message) => {
  const text = String(message || '');
  return text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE - 3) + '...' : text;
};

/**
 * Show the dialog and return a handle that can close it early (the phone answered first).
 * @param {{ message: string, timeoutSec?: number, spawner?: Function }} opts
 * @returns {{ result: Promise<'deny'|'once'|'hour'>, cancel: () => void }}
 */
export function start({ message, timeoutSec = 60, spawner = defaultSpawner }) {
  let child = null;
  let result;
  try {
    const spawned = spawner([clip(message), String(timeoutSec)], { timeoutMs: (timeoutSec + 15) * 1000 });
    child = spawned.child;
    result = Promise.resolve(spawned.output).then(mapReply, () => 'deny');
  } catch {
    result = Promise.resolve('deny');
  }
  return {
    result,
    cancel() {
      try {
        if (child && child.exitCode == null && !child.killed) child.kill('SIGTERM');
      } catch {}
    }
  };
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
  const text = clip(message);
  try {
    const output = await runner([text, String(timeoutSec)], { timeoutMs: (timeoutSec + 15) * 1000 });
    return mapReply(output);
  } catch {
    return 'deny';
  }
}
