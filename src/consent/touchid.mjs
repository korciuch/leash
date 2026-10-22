// Touch ID through the compiled helper (helper/Leash.swift).
// Exit codes: 0 approved, 1 denied or cancelled, 2 unavailable.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @returns {string} helper path: LEASH_TOUCHID or <repo>/helper/Leash */
export function helperPath() {
  return process.env.LEASH_TOUCHID || join(repoRoot, 'helper', 'Leash');
}

/**
 * Default runner: run the helper, resolve with its exit code and output.
 * @param {string} helper
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
export function defaultRunner(helper, args) {
  return new Promise((resolve) => {
    execFile(helper, args, { timeout: 90000 }, (error, stdout) => {
      const output = String(stdout || '').trim();
      if (!error) return resolve({ code: 0, output });
      if (typeof error.code === 'number') return resolve({ code: error.code, output });
      if (error.killed) return resolve({ code: 1, output: output || 'timed out' });
      resolve({ code: 2, output: output || String(error.message || error) });
    });
  });
}

/**
 * Ask for Touch ID.
 * @param {string} reason shown in the prompt after "Leash is trying to"
 * @param {{ helper?: string, runner?: Function }} [opts]
 * @returns {Promise<{ approved: boolean, code: number, output: string }>}
 */
export async function verify(reason, { helper = helperPath(), runner = defaultRunner } = {}) {
  if (runner === defaultRunner && !existsSync(helper)) {
    return { approved: false, code: 2, output: `Touch ID helper not found at ${helper}. Build it with: swiftc helper/Leash.swift -o helper/Leash` };
  }
  const args = [String(reason || 'approve this action')];
  if (process.env.LEASH_TOUCHID_PASSWORD === '1') args.push('--allow-password');
  try {
    const { code, output } = await runner(helper, args);
    return { approved: code === 0, code, output };
  } catch (error) {
    return { approved: false, code: 2, output: String(error && error.message || error) };
  }
}
