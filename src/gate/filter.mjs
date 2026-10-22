// Result filters: keep only the grant's records and fields before the model sees them.
import { sameMailbox } from './policy.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const EVENT_FIELDS = ['title', 'start', 'end', 'location', 'notes'];
const REMINDER_FIELDS = ['title', 'notes', 'completed', 'due'];
const MESSAGE_FIELDS = ['from', 'to', 'subject', 'date', 'body'];

const norm = (s) => String(s ?? '').trim().toLowerCase();
const inNames = (list, name) => Array.isArray(list) && list.some((x) => norm(x) === norm(name));

/**
 * Keeps granted fields plus structural keys; records which fields were removed.
 * @param {object} item
 * @param {string[]} fields
 * @param {string[]} keep always kept
 * @param {Set<string>} removed collects removed field names
 */
function pick(item, fields, keep, removed) {
  const all = Array.isArray(fields) && fields.includes('*');
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (all || keep.includes(k) || (Array.isArray(fields) && fields.includes(k))) {
      out[k] = v;
    } else if (v !== undefined && v !== null && v !== '') {
      removed.add(k);
    }
  }
  return out;
}

/** Orders removed names by the app's known field order, unknown names last. */
function orderFields(removed, known) {
  const names = [...removed];
  const rank = (n) => (known.includes(n) ? known.indexOf(n) : known.length);
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * @param {any[]} events [{ id, calendar, title, start, end, location, notes }]
 * @param {import('./grants.mjs').Grant|null} grant
 * @param {{calendars?: string[], from?: string, to?: string}} [clamp]
 * @param {Date} [now] used only when the clamp has no window
 * @returns {{items: any[], hidden: {records: number, fields: string[]}}}
 */
export function filterEvents(events, grant, clamp = {}, now = new Date()) {
  const list = Array.isArray(events) ? events : [];
  const removed = new Set();
  if (!grant) return { items: [], hidden: { records: list.length, fields: [] } };
  const r = grant.records || {};
  let calendars = Array.isArray(r.calendars) ? r.calendars : [];
  if (clamp && Array.isArray(clamp.calendars)) calendars = calendars.filter((c) => inNames(clamp.calendars, c));

  let from = clamp?.from != null ? Date.parse(clamp.from) : NaN;
  let to = clamp?.to != null ? Date.parse(clamp.to) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    if (typeof r.windowDays === 'number' && r.windowDays > 0) {
      if (!Number.isFinite(from)) from = now.getTime();
      if (!Number.isFinite(to)) to = now.getTime() + r.windowDays * DAY_MS;
    }
  }
  const haveWindow = Number.isFinite(from) && Number.isFinite(to);

  const items = [];
  for (const ev of list) {
    if (!ev || !inNames(calendars, ev.calendar) || !haveWindow) continue;
    const s = Date.parse(ev.start);
    const eRaw = ev.end != null ? Date.parse(ev.end) : s;
    const e = Number.isFinite(eRaw) ? eRaw : s;
    if (!Number.isFinite(s)) continue;
    const overlaps = s < to && (e > from || (e === s && s >= from));
    if (!overlaps) continue;
    items.push(pick(ev, grant.fields, ['id', 'calendar'], removed));
  }
  return { items, hidden: { records: list.length - items.length, fields: orderFields(removed, EVENT_FIELDS) } };
}

/**
 * @param {any[]} items [{ id, list, title, notes, completed, due }]
 * @param {import('./grants.mjs').Grant|null} grant
 * @returns {{items: any[], hidden: {records: number, fields: string[]}}}
 */
export function filterReminders(items, grant) {
  const list = Array.isArray(items) ? items : [];
  const removed = new Set();
  if (!grant) return { items: [], hidden: { records: list.length, fields: [] } };
  const lists = grant.records?.lists || [];
  const out = [];
  for (const it of list) {
    if (!it || !inNames(lists, it.list)) continue;
    out.push(pick(it, grant.fields, ['id', 'list'], removed));
  }
  return { items: out, hidden: { records: list.length - out.length, fields: orderFields(removed, REMINDER_FIELDS) } };
}

/**
 * @param {any[]} messages [{ id, account, mailbox, from, to, subject, date, body, read }]
 * @param {import('./grants.mjs').Grant|null} grant
 * @param {Date} [now]
 * @returns {{items: any[], hidden: {records: number, fields: string[]}}}
 */
export function filterMessages(messages, grant, now = new Date()) {
  const list = Array.isArray(messages) ? messages : [];
  const removed = new Set();
  if (!grant) return { items: [], hidden: { records: list.length, fields: [] } };
  const r = grant.records || {};
  const mailboxes = Array.isArray(r.mailboxes) ? r.mailboxes : [];
  const since = typeof r.sinceDays === 'number' ? now.getTime() - r.sinceDays * DAY_MS : null;
  const out = [];
  for (const m of list) {
    if (!m || !mailboxes.some((g) => sameMailbox(g, m))) continue;
    if (since != null) {
      const d = Date.parse(m.date);
      if (!Number.isFinite(d) || d < since) continue;
    }
    out.push(pick(m, grant.fields, ['id', 'account', 'mailbox', 'read'], removed));
  }
  return { items: out, hidden: { records: list.length - out.length, fields: orderFields(removed, MESSAGE_FIELDS) } };
}
