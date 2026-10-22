// Leash data directory. Every function reads process.env.LEASH_HOME at call time
// so tests and separate processes (server, viewer, cli) agree on one location.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @returns {string} the Leash data directory (LEASH_HOME or ~/.leash) */
export function leashHome() {
  const env = process.env.LEASH_HOME;
  return env && env.trim() ? env : join(homedir(), '.leash');
}

/** @returns {string} */
export function grantsPath() {
  return join(leashHome(), 'grants.json');
}

/** @returns {string} */
export function ledgerPath() {
  return join(leashHome(), 'ledger.jsonl');
}

/** @returns {string} */
export function draftsPath() {
  return join(leashHome(), 'drafts.json');
}

/** Creates the data directory if needed. @returns {string} the directory */
export function ensureHome() {
  const dir = leashHome();
  mkdirSync(dir, { recursive: true });
  return dir;
}
