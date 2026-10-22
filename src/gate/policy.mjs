// Policy: decides whether an action is covered by an active grant.
import { isActive, newGrantId } from './grants.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const APPS = ['calendar', 'reminders', 'mail', 'messages'];
export const VERBS = ['read', 'create', 'draft', 'modify', 'send', 'delete'];

const APP_LABEL = { calendar: 'Calendar', reminders: 'Reminders', mail: 'Mail', messages: 'Messages' };

const TIERS = { read: 0, create: 1, draft: 1, modify: 2, send: 3, delete: 3 };

/**
 * Risk tier of a verb: read 0, create/draft 1, modify 2, send/delete 3.
 * Unknown verbs are treated as top tier.
 * @param {string} verb
 * @returns {0|1|2|3}
 */
export function tierOf(verb) {
  return /** @type {0|1|2|3} */ (TIERS[verb] ?? 3);
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const LOCAL = new Set(['local', 'on my mac']);
const normAccount = (s) => (LOCAL.has(norm(s)) ? 'local' : norm(s));

/** @param {{account?: string, mailbox?: string}} a @param {{account?: string, mailbox?: string}} b */
export function sameMailbox(a, b) {
  return normAccount(a.account) === normAccount(b.account) && norm(a.mailbox) === norm(b.mailbox);
}

function includesName(list, name) {
  return Array.isArray(list) && list.some((x) => norm(x) === norm(name));
}

/**
 * Returns the clamp if the grant's records cover the target, else null.
 * @param {import('./grants.mjs').Grant} grant
 * @param {any} action
 * @param {Date} now
 * @returns {object|null}
 */
function cover(grant, action, now) {
  const r = grant.records || {};
  const t = action.target || {};
  const clamp = {};

  if (action.app === 'calendar') {
    if (!Array.isArray(r.calendars) || r.calendars.length === 0) return null;
    if (Array.isArray(t.calendars) && t.calendars.length > 0) {
      if (!t.calendars.every((c) => includesName(r.calendars, c))) return null;
      clamp.calendars = [...t.calendars];
    } else {
      clamp.calendars = [...r.calendars];
    }
    if (typeof r.windowDays !== 'number' || !(r.windowDays > 0)) return null;
    const winStart = now.getTime();
    const winEnd = winStart + r.windowDays * DAY_MS;
    const reqFrom = t.from != null ? Date.parse(t.from) : NaN;
    const reqTo = t.to != null ? Date.parse(t.to) : NaN;
    const from = Number.isFinite(reqFrom) ? Math.max(reqFrom, winStart) : winStart;
    const to = Number.isFinite(reqTo) ? Math.min(reqTo, winEnd) : winEnd;
    if (from >= to) return null;
    clamp.from = new Date(from).toISOString();
    clamp.to = new Date(to).toISOString();
  }

  if (action.app === 'reminders') {
    if (!Array.isArray(r.lists) || r.lists.length === 0) return null;
    if (t.list != null && t.list !== '') {
      if (!includesName(r.lists, t.list)) return null;
      clamp.lists = [t.list];
    } else {
      clamp.lists = [...r.lists];
    }
  }

  if (action.app === 'mail') {
    const granted = Array.isArray(r.mailboxes) ? r.mailboxes : [];
    if (t.mailbox != null || t.account != null) {
      const wanted = { account: t.account, mailbox: t.mailbox };
      const match = granted.find((m) => sameMailbox(m, wanted));
      if (!match) return null;
      clamp.mailboxes = [{ ...match }];
    } else if (action.verb === 'read' || action.verb === 'modify' || action.verb === 'delete') {
      if (granted.length === 0) return null;
      clamp.mailboxes = granted.map((m) => ({ ...m }));
    } else if (granted.length > 0) {
      clamp.mailboxes = granted.map((m) => ({ ...m }));
    }
    if (typeof r.sinceDays === 'number') clamp.sinceDays = r.sinceDays;
  }

  const recipients = Array.isArray(t.recipients) ? t.recipients : [];
  if (recipients.length > 0 || (action.app === 'messages' && action.verb === 'send')) {
    if (Array.isArray(r.recipients)) {
      if (recipients.length === 0) return null;
      if (!recipients.every((x) => includesName(r.recipients, x))) return null;
    } else if (!(action.app === 'mail' && (grant.verbs || []).includes('send'))) {
      return null;
    }
  }

  return clamp;
}

/**
 * Decides what to do with an action.
 * @param {any} action
 * @param {import('./grants.mjs').Grant[]} grants
 * @param {Date} [now]
 * @returns {{outcome: 'allow'|'ask'|'touchid'|'deny', grant?: any, reason: string, clamp?: object}}
 */
export function decide(action, grants, now = new Date()) {
  if (!action || !APPS.includes(action.app)) {
    return { outcome: 'deny', reason: `Leash does not handle the app "${action?.app}"` };
  }
  if (!VERBS.includes(action.verb)) {
    return { outcome: 'deny', reason: `Leash does not handle the action "${action.verb}"` };
  }
  const label = APP_LABEL[action.app];
  const sameApp = (grants || []).filter((g) => g && g.app === action.app);
  const active = sameApp.filter((g) => isActive(g, now));

  for (const grant of active) {
    if (!(grant.verbs || []).includes(action.verb)) continue;
    const clamp = cover(grant, action, now);
    if (!clamp) continue;
    if (tierOf(action.verb) >= 3) {
      return { outcome: 'touchid', grant, reason: `Covered by "${grant.name}", sending needs Touch ID`, clamp };
    }
    return { outcome: 'allow', grant, reason: `Covered by "${grant.name}"`, clamp };
  }

  let reason;
  if (active.length > 0) {
    const names = active.map((g) => `"${g.name}"`).join(', ');
    reason = `Not covered by ${names}`;
  } else if (sameApp.length > 0) {
    const last = sameApp[sameApp.length - 1];
    reason = last.revokedAt ? `Grant "${last.name}" was revoked` : `Grant "${last.name}" expired`;
  } else {
    reason = `No grant covers ${label}`;
  }
  return { outcome: 'ask', reason };
}

const DEFAULT_FIELDS = {
  calendar: ['title', 'start', 'end'],
  reminders: ['*'],
  mail: ['from', 'to', 'subject', 'date', 'body'],
  messages: ['*'],
};

/**
 * Builds a 1 hour grant scoped to exactly this action, for "Allow for 1 hour".
 * @param {any} action
 * @param {'deny'|'once'|'hour'} choice
 * @param {Date} [now]
 * @returns {import('./grants.mjs').Grant|null}
 */
export function grantFromApproval(action, choice, now = new Date()) {
  if (choice !== 'hour' || !action || !APPS.includes(action.app)) return null;
  const t = action.target || {};
  const records = {};
  if (action.app === 'calendar') {
    records.calendars = Array.isArray(t.calendars) ? [...t.calendars] : [];
    const to = t.to != null ? Date.parse(t.to) : NaN;
    records.windowDays = Number.isFinite(to) ? Math.max(1, Math.ceil((to - now.getTime()) / DAY_MS)) : 7;
  }
  if (action.app === 'reminders') {
    records.lists = t.list ? [t.list] : [];
  }
  if (action.app === 'mail') {
    if (t.mailbox != null || t.account != null) {
      records.mailboxes = [{ account: t.account ?? '', mailbox: t.mailbox ?? '' }];
      records.sinceDays = 30;
    }
  }
  if (Array.isArray(t.recipients) && t.recipients.length > 0) {
    records.recipients = [...t.recipients];
  }
  const summary = String(action.summary || `${action.verb} ${APP_LABEL[action.app]}`);
  const name = summary.length > 60 ? summary.slice(0, 57) + '...' : summary;
  return {
    id: newGrantId(),
    name,
    app: action.app,
    verbs: [action.verb],
    records,
    fields: [...DEFAULT_FIELDS[action.app]],
    expiresAt: new Date(now.getTime() + HOUR_MS).toISOString(),
    createdAt: now.toISOString(),
    source: 'dialog',
  };
}
