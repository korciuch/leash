// Runs the fixed JXA scripts in ./scripts with osascript and turns failures into AppleError.
// Scripts take one JSON argument and print one JSON value. User input only ever travels
// inside that JSON argument; scripts are never built from strings.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = fileURLToPath(new URL('./scripts/', import.meta.url));

/** Which app each script talks to, for error messages. */
export const SCRIPT_APPS = {
  'calendar-events': 'Calendar',
  'reminders-list': 'Reminders',
  'reminders-create': 'Reminders',
  'mail-list': 'Mail',
  'mail-read': 'Mail',
  'mail-send': 'Mail',
  'messages-send': 'Messages',
  ping: null
};

export const DEFAULT_TIMEOUT_MS = 30000;

export class AppleError extends Error {
  /** @param {{ app?: string|null, code?: number|null, message: string, fix?: string }} info */
  constructor({ app = null, code = null, message, fix }) {
    super(message);
    this.name = 'AppleError';
    this.app = app;
    this.code = code;
    this.fix = fix || fixFor(code, app);
  }

  toJSON() {
    return { name: this.name, app: this.app, code: this.code, message: this.message, fix: this.fix };
  }
}

/** Plain-English fix for a macOS Apple Event error code. */
export function fixFor(code, app) {
  const target = app || 'the app';
  switch (code) {
    case -1743:
      return `Turn on System Settings > Privacy & Security > Automation > node > ${target}. If Leash runs inside Claude or Terminal, the switch is listed under that app instead.`;
    case -1712:
      return `${target} took too long to answer. Open ${target}, wait for it to finish loading, then try again.`;
    case -1728:
      return `${target} could not find it. Check the calendar, list or mailbox name.`;
    case -1719:
      return `${target} was asked for an item that does not exist. Try again with a smaller limit.`;
    case -600:
      return `${target} is not running and could not be launched. Open ${target} once by hand, then try again.`;
    default:
      return `${target} returned an error. Open ${target} and try again.`;
  }
}

export function osascriptPath() {
  return process.env.LEASH_OSASCRIPT || '/usr/bin/osascript';
}

export function scriptPath(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(SCRIPT_APPS, name)) {
    throw new AppleError({ app: null, code: null, message: `Unknown Apple script: ${String(name)}`, fix: 'This is a Leash bug: the script name is not in the fixed list.' });
  }
  return path.join(SCRIPTS_DIR, `${name}.js`);
}

/** Pull an Apple Event error number like "(-1743)" out of osascript stderr. */
export function codeFromText(text) {
  const match = /\((-\d{1,5})\)\s*$/m.exec(String(text || '').trim()) || /(-\d{3,5})\b/.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Run one fixed JXA script.
 * @param {string} name script name without .js, e.g. 'calendar-events'
 * @param {object} args one JSON-serializable argument
 * @param {{ timeoutMs?: number, app?: string }} [opts]
 * @returns {Promise<any>} parsed JSON the script printed
 */
export function runScript(name, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, app } = {}) {
  const appName = app || SCRIPT_APPS[name] || (args && typeof args.app === 'string' ? args.app : null);
  let file;
  try {
    file = scriptPath(name);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!existsSync(file)) {
    return Promise.reject(new AppleError({ app: appName, message: `Apple script missing: ${name}.js`, fix: 'This is a Leash bug: reinstall or check src/apple/scripts.' }));
  }
  const argv = ['-l', 'JavaScript', file, JSON.stringify(args ?? {})];
  return new Promise((resolve, reject) => {
    execFile(osascriptPath(), argv, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || error.signal) {
          reject(new AppleError({ app: appName, code: -1712, message: `${appName || 'The app'} did not answer within ${Math.round(timeoutMs / 1000)} s.` }));
          return;
        }
        if (error.code === 'ENOENT') {
          reject(new AppleError({ app: appName, code: null, message: `osascript not found at ${osascriptPath()}.`, fix: 'Leash needs macOS. Set LEASH_OSASCRIPT only for tests.' }));
          return;
        }
        const text = String(stderr || error.message || '').trim();
        const code = codeFromText(text);
        reject(new AppleError({ app: appName, code, message: text || `osascript failed for ${name}.` }));
        return;
      }
      let value;
      try {
        value = parseOutput(stdout);
      } catch {
        reject(new AppleError({ app: appName, code: null, message: `${name} printed something that is not JSON.`, fix: 'This is a Leash bug: the script output could not be read.' }));
        return;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && value.error && typeof value.error === 'object') {
        const code = typeof value.error.code === 'number' ? value.error.code : codeFromText(value.error.message);
        reject(new AppleError({ app: value.error.app || appName, code, message: String(value.error.message || 'Unknown error') }));
        return;
      }
      resolve(value);
    });
  });
}

export function parseOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error('empty output');
  return JSON.parse(text);
}
