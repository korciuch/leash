// File-backed grant store. grants.json is re-read on every call because the
// viewer revokes grants from another process, and written atomically.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ensureHome, grantsPath } from './paths.mjs';

const HOUR_MS = 60 * 60 * 1000;

/**
 * @typedef {'read'|'create'|'draft'|'modify'|'send'|'delete'} Verb
 * @typedef {'calendar'|'reminders'|'mail'|'messages'} App
 * @typedef {{
 *   id: string, name: string, app: App, verbs: Verb[],
 *   records: {
 *     calendars?: string[], windowDays?: number, lists?: string[],
 *     mailboxes?: {account: string, mailbox: string}[], sinceDays?: number,
 *     recipients?: string[]
 *   },
 *   fields: string[], expiresAt: string|null, createdAt: string,
 *   revokedAt?: string, revokedBy?: string,
 *   source: 'seed'|'dialog'|'cli'|'viewer'
 * }} Grant
 */

/** @returns {string} a short random grant id like 'g_ab12cd' */
export function newGrantId() {
  return 'g_' + randomBytes(3).toString('hex');
}

/**
 * The three demo grants. Names come from env when set.
 * @param {Date} [now]
 * @returns {Grant[]}
 */
export function seedGrants(now = new Date()) {
  const created = now.toISOString();
  const inOneHour = new Date(now.getTime() + HOUR_MS).toISOString();
  const calendar = process.env.LEASH_CALENDAR || 'Leash Demo';
  const account = process.env.LEASH_MAIL_ACCOUNT || 'Alumni';
  const mailbox = process.env.LEASH_MAIL_MAILBOX || 'Leash Demo';
  const errands = process.env.LEASH_ERRANDS || 'Errands';
  return [
    {
      id: 'g_plan_week',
      name: 'Plan the week',
      app: 'calendar',
      verbs: ['read'],
      records: { calendars: [calendar], windowDays: 7 },
      fields: ['title', 'start', 'end'],
      expiresAt: inOneHour,
      createdAt: created,
      source: 'seed',
    },
    {
      id: 'g_draft_replies',
      name: 'Draft replies',
      app: 'mail',
      verbs: ['read', 'draft', 'send'],
      records: { mailboxes: [{ account, mailbox }], sinceDays: 30 },
      fields: ['from', 'subject', 'date', 'body'],
      expiresAt: inOneHour,
      createdAt: created,
      source: 'seed',
    },
    {
      id: 'g_errands',
      name: 'Errands list',
      app: 'reminders',
      verbs: ['read', 'create'],
      records: { lists: [errands] },
      fields: ['*'],
      expiresAt: null,
      createdAt: created,
      source: 'seed',
    },
  ];
}

/** @param {Grant[]} grants */
function writeGrants(grants) {
  ensureHome();
  const file = grantsPath();
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ grants }, null, 2) + '\n');
  renameSync(tmp, file);
}

/**
 * All grants, including expired and revoked. Seeds the file if it is missing.
 * @returns {Grant[]}
 */
export function loadGrants() {
  const file = grantsPath();
  if (!existsSync(file)) {
    const seeded = seedGrants();
    writeGrants(seeded);
    return seeded;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Leash could not read ${file}: ${err.message}. Run "leash reset" to start over.`);
  }
  return Array.isArray(data?.grants) ? data.grants : [];
}

/**
 * @param {Grant} grant
 * @param {Date} [now]
 * @returns {boolean} true when not revoked and not expired
 */
export function isActive(grant, now = new Date()) {
  if (!grant || grant.revokedAt) return false;
  if (grant.expiresAt == null) return true;
  const t = Date.parse(grant.expiresAt);
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * @param {Date} [now]
 * @returns {Grant[]} grants that are not revoked and not expired
 */
export function activeGrants(now = new Date()) {
  return loadGrants().filter((g) => isActive(g, now));
}

/**
 * Adds a grant. Fills id and createdAt when missing.
 * @param {Partial<Grant>} partial
 * @returns {Grant}
 */
export function addGrant(partial) {
  const grants = loadGrants();
  /** @type {Grant} */
  const grant = {
    name: 'Grant',
    verbs: [],
    records: {},
    fields: [],
    expiresAt: null,
    source: 'cli',
    ...partial,
    id: partial.id || newGrantId(),
    createdAt: partial.createdAt || new Date().toISOString(),
  };
  while (grants.some((g) => g.id === grant.id)) grant.id = newGrantId();
  grants.push(grant);
  writeGrants(grants);
  return grant;
}

/**
 * Revokes a grant by id. Already revoked grants are returned unchanged.
 * @param {string} id
 * @param {string} [by]
 * @returns {Grant|null}
 */
export function revokeGrant(id, by = 'cli') {
  const grants = loadGrants();
  const grant = grants.find((g) => g.id === id);
  if (!grant) return null;
  if (grant.revokedAt) return grant;
  grant.revokedAt = new Date().toISOString();
  grant.revokedBy = by;
  writeGrants(grants);
  return grant;
}

/**
 * Rewrites grants.json with fresh seed grants.
 * @param {Date} [now]
 * @returns {Grant[]}
 */
export function resetToSeed(now = new Date()) {
  const seeded = seedGrants(now);
  writeGrants(seeded);
  return seeded;
}
