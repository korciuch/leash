// Pending approvals, shared between the MCP server (Mac dialog) and the viewer (phone page).
// One JSON file per approval in LEASH_HOME/approvals/<id>.json, written atomically (temp file, rename).
// The token is never stored: only its sha256, compared in constant time.
// First decision wins across processes: deciding claims <id>.lock with an exclusive create.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, readdirSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { leashHome } from './gate/paths.mjs';

export const TTL_MS = 60 * 1000;
export const CHOICES = ['deny', 'once', 'hour'];
const ID_RE = /^a_[0-9a-f]{16}$/;

const sha = (s) => createHash('sha256').update(String(s)).digest();

/** @returns {string} LEASH_HOME/approvals (created on demand) */
export function approvalsDir() {
  const dir = join(leashHome(), 'approvals');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const fileOf = (id) => join(approvalsDir(), `${id}.json`);

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function readRaw(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try {
    return JSON.parse(readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
}

/** Public view: no token hash, status 'expired' once past expiresAt while still pending. */
function view(raw, now = new Date()) {
  if (!raw) return null;
  const { tokenHash, ...rest } = raw;
  if (rest.status === 'pending' && new Date(rest.expiresAt).getTime() <= now.getTime()) rest.status = 'expired';
  return rest;
}

/**
 * Create a pending approval.
 * @param {{ tool?: string, app?: string, verb?: string, summary: string, why?: string, detail?: string, agent?: string, ttlMs?: number, now?: Date }} info
 * @returns {{ id: string, token: string, approval: object }}
 */
export function createApproval({ tool, app, verb, summary, why, detail, agent, ttlMs = TTL_MS, now = new Date() } = {}) {
  const id = 'a_' + randomBytes(8).toString('hex');
  const token = randomBytes(24).toString('base64url');
  const raw = {
    id, tool: tool || null, app: app || null, verb: verb || null,
    summary: String(summary || ''), why: why ? String(why) : null, detail: detail ? String(detail) : null, agent: agent || 'Claude',
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    status: 'pending', choice: null, decidedBy: null, decidedAt: null,
    tokenHash: sha(token).toString('hex')
  };
  writeAtomic(fileOf(id), raw);
  return { id, token, approval: view(raw, now) };
}

/** @returns {object|null} the approval without its token hash */
export function getApproval(id, now = new Date()) {
  return view(readRaw(id), now);
}

/** @returns {object[]} all approvals, newest first */
export function listApprovals(now = new Date()) {
  let names = [];
  try {
    names = readdirSync(approvalsDir()).filter((f) => f.endsWith('.json'));
  } catch {}
  return names.map((f) => getApproval(f.slice(0, -5), now)).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Constant-time token check. @returns {boolean} */
export function checkToken(id, token) {
  const raw = readRaw(id);
  if (!raw || typeof token !== 'string' || !token || typeof raw.tokenHash !== 'string') return false;
  const expected = Buffer.from(raw.tokenHash, 'hex');
  const given = sha(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function claim(id, raw, choice, by, now) {
  try {
    closeSync(openSync(join(approvalsDir(), `${id}.lock`), 'wx'));
  } catch {
    const current = view(readRaw(id), now);
    return { ok: false, error: 'already_decided', approval: current };
  }
  const updated = { ...raw, status: choice === 'deny' ? 'denied' : 'approved', choice, decidedBy: by, decidedAt: now.toISOString() };
  writeAtomic(fileOf(id), updated);
  return { ok: true, approval: view(updated, now) };
}

/**
 * Decide from the phone page (token required). First decision wins; expired approvals are refused.
 * @param {string} id
 * @param {string} token
 * @param {'deny'|'once'|'hour'} choice
 * @param {{ by?: string, now?: Date }} [opts]
 * @returns {{ ok: boolean, error?: 'not_found'|'bad_token'|'bad_choice'|'expired'|'already_decided', approval?: object }}
 */
export function decideApproval(id, token, choice, { by = 'phone', now = new Date() } = {}) {
  const raw = readRaw(id);
  if (!raw) return { ok: false, error: 'not_found' };
  if (!checkToken(id, token)) return { ok: false, error: 'bad_token' };
  if (!CHOICES.includes(choice)) return { ok: false, error: 'bad_choice' };
  if (raw.status !== 'pending') return { ok: false, error: 'already_decided', approval: view(raw, now) };
  if (new Date(raw.expiresAt).getTime() <= now.getTime()) return { ok: false, error: 'expired', approval: view(raw, now) };
  return claim(id, raw, choice, by, now);
}

/**
 * Record a decision made on the Mac or by the timeout (no token: same process that created it).
 * @param {string} id
 * @param {'deny'|'once'|'hour'} choice
 * @param {'mac'|'timeout'|string} by
 */
export function markDecided(id, choice, by, now = new Date()) {
  const raw = readRaw(id);
  if (!raw) return { ok: false, error: 'not_found' };
  if (raw.status !== 'pending') return { ok: false, error: 'already_decided', approval: view(raw, now) };
  return claim(id, raw, CHOICES.includes(choice) ? choice : 'deny', by, now);
}

/** The Mac's LAN IPv4 (Wi-Fi or Ethernet, en*), skipping VM bridges, VPNs and link-local; or null. */
export function lanAddress(interfaces = networkInterfaces()) {
  const skip = /^(bridge|utun|awdl|llw|vmnet|vnic|gif|stf|anpi|ap)\d*/;
  const candidates = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (skip.test(name)) continue;
    for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal) continue;
      if (a.address.startsWith('169.254.') || a.address.startsWith('192.168.64.')) continue;
      candidates.push({ name, address: a.address });
    }
  }
  const en = candidates.find((c) => /^en\d+$/.test(c.name));
  return (en || candidates[0] || {}).address || null;
}

/** Phone link: LEASH_PUBLIC_URL or http://<LAN IPv4>:<LEASH_VIEWER_PORT or 4777>, then /a/<id>?t=<token>. */
export function approvalUrl(id, token, { env = process.env, interfaces } = {}) {
  const base = env.LEASH_PUBLIC_URL && env.LEASH_PUBLIC_URL.trim()
    ? env.LEASH_PUBLIC_URL.trim().replace(/\/+$/, '')
    : `http://${lanAddress(interfaces) || '127.0.0.1'}:${env.LEASH_VIEWER_PORT || 4777}`;
  return `${base}/a/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
}

export const isApprovalId = (id) => ID_RE.test(String(id || ''));
export const approvalExists = (id) => isApprovalId(id) && existsSync(fileOf(id));
