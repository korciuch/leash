// Mail adapter: one mailbox at a time, plus send (only after Touch ID).
import { runScript } from './jxa.mjs';

export const MAX_LIMIT = 100;

/** Clamp a requested limit to 1..MAX_LIMIT (default 20). */
export function clampLimit(limit, fallback = 20) {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

/** Normalize recipients: array or comma separated string to a list of trimmed addresses. */
export function normalizeAddresses(to) {
  const list = Array.isArray(to) ? to : String(to ?? '').split(/[,;]/);
  return [...new Set(list.map((a) => String(a).trim()).filter(Boolean))];
}

/**
 * @param {{ account: string, mailbox: string, sinceDays?: number, limit?: number }} query
 * @returns {Promise<{ id: string, account: string, mailbox: string, from: string, subject: string, date: string, read: boolean }[]>}
 */
export async function listMessages({ account, mailbox, sinceDays, limit = 20 } = {}, { run = runScript, timeoutMs } = {}) {
  if (!account || !mailbox) throw new TypeError('listMessages needs an account and a mailbox');
  const args = { account: String(account), mailbox: String(mailbox), limit: clampLimit(limit) };
  const days = Number(sinceDays);
  if (Number.isFinite(days) && days > 0) args.sinceDays = days;
  const result = await run('mail-list', args, timeoutMs ? { timeoutMs } : {});
  return Array.isArray(result) ? result.slice(0, args.limit) : [];
}

/**
 * @param {{ account: string, mailbox: string, id: string|number }} query
 * @returns {Promise<{ id: string, account: string, mailbox: string, from: string, to: string, subject: string, date: string, body: string }>}
 */
export async function readMessage({ account, mailbox, id } = {}, { run = runScript, timeoutMs } = {}) {
  if (!account || !mailbox) throw new TypeError('readMessage needs an account and a mailbox');
  const idText = String(id ?? '').trim();
  if (!/^\d+$/.test(idText)) throw new TypeError(`Mail message ids are numbers, got: ${idText || 'nothing'}`);
  return run('mail-read', { account: String(account), mailbox: String(mailbox), id: idText }, timeoutMs ? { timeoutMs } : {});
}

/**
 * Sends right away. Only call after the human approved with Touch ID.
 * @param {{ to: string|string[], subject: string, body: string }} message
 * @returns {Promise<{ sent: true }>}
 */
export async function sendMessage({ to, subject, body } = {}, { run = runScript, timeoutMs = 60000 } = {}) {
  const recipients = normalizeAddresses(to);
  if (!recipients.length) throw new TypeError('sendMessage needs at least one recipient');
  const bad = recipients.filter((a) => !/^[^\s@]+@[^\s@]+$/.test(a));
  if (bad.length) throw new TypeError(`Not an email address: ${bad.join(', ')}`);
  await run('mail-send', { to: recipients, subject: String(subject ?? ''), body: String(body ?? '') }, { timeoutMs });
  return { sent: true };
}
