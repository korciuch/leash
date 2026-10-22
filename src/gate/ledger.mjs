// Hash-chained, append-only ledger (ledger.jsonl). Each entry's hash is sha256
// over the entry without `hash` (keys sorted); prev is the previous hash or 'genesis'.
import { readFileSync, appendFileSync, existsSync, renameSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { ensureHome, ledgerPath } from './paths.mjs';

export const GENESIS = 'genesis';

/** Stable JSON with sorted object keys, so the hash does not depend on key order. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

/** @param {object} entry @returns {string} sha256 hex over the entry without `hash` */
export function hashEntry(entry) {
  const { hash, ...rest } = entry;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

function readLines() {
  const file = ledgerPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

/**
 * @returns {object[]} all parseable entries in file order
 */
export function readAll() {
  const out = [];
  for (const line of readLines()) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // unreadable line: verify() reports it
    }
  }
  return out;
}

/** @param {number} [n] @returns {object[]} the last n entries, oldest first */
export function tail(n = 20) {
  const all = readAll();
  return n > 0 ? all.slice(-n) : [];
}

/**
 * Appends one entry, filling seq, time, prev and hash.
 * @param {object} partial
 * @returns {object} the LedgerEntry written
 */
export function append(partial = {}) {
  ensureHome();
  return withLock(() => appendLocked(partial));
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Several Leash processes (Claude Desktop, the VM's HTTP server) share one ledger: append under a lock file. */
function withLock(fn) {
  const lock = ledgerPath() + '.lock';
  const deadline = Date.now() + 3000;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lock, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
      } catch {}
      if (Date.now() > deadline) throw new Error('Leash ledger is busy');
      pause(5);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch {}
  }
}

function appendLocked(partial) {
  const lines = readLines();
  let last = null;
  if (lines.length > 0) {
    try {
      last = JSON.parse(lines[lines.length - 1]);
    } catch {
      last = null;
    }
  }
  const { seq: _s, time: _t, prev: _p, hash: _h, ...extra } = partial;
  const entry = {
    seq: last && Number.isInteger(last.seq) ? last.seq + 1 : lines.length + 1,
    time: new Date().toISOString(),
    agent: 'claude',
    tool: '',
    app: null,
    verb: null,
    grantId: null,
    decision: '',
    summary: '',
    records: [],
    returned: '',
    ...extra,
    prev: last && typeof last.hash === 'string' ? last.hash : GENESIS,
  };
  if (!entry.agent) entry.agent = 'claude';
  if (!Array.isArray(entry.records)) entry.records = entry.records == null ? [] : [String(entry.records)];
  entry.hash = hashEntry(entry);
  appendFileSync(ledgerPath(), JSON.stringify(entry) + '\n');
  return entry;
}

/**
 * Checks every link and hash.
 * @returns {{entries: number, intact: boolean, brokenAt?: number, reason?: string}}
 */
export function verify() {
  const lines = readLines();
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const at = i + 1;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { entries: lines.length, intact: false, brokenAt: at, reason: `Line ${at} is not valid JSON` };
    }
    if (entry.seq !== at) {
      return { entries: lines.length, intact: false, brokenAt: at, reason: `Entry ${at} has seq ${entry.seq}` };
    }
    if (entry.prev !== prev) {
      return { entries: lines.length, intact: false, brokenAt: at, reason: `Entry ${at} does not link to the one before it` };
    }
    if (entry.hash !== hashEntry(entry)) {
      return { entries: lines.length, intact: false, brokenAt: at, reason: `Entry ${at} was changed after it was written` };
    }
    prev = entry.hash;
  }
  return { entries: lines.length, intact: true };
}

/**
 * Moves the current ledger to ledger.<timestamp>.jsonl so the next append starts a fresh chain.
 * @returns {{archivedTo: string|null}}
 */
export function archive() {
  ensureHome();
  const file = ledgerPath();
  if (!existsSync(file) || statSync(file).size === 0) return { archivedTo: null };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = join(dirname(file), `ledger.${stamp}.jsonl`);
  let n = 1;
  while (existsSync(target)) target = join(dirname(file), `ledger.${stamp}-${n++}.jsonl`);
  renameSync(file, target);
  return { archivedTo: target };
}
