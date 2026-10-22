// Reminders adapter: named lists only.
import { runScript } from './jxa.mjs';

/**
 * @param {{ lists: string[], includeCompleted?: boolean }} query
 * @returns {Promise<{ id: string, list: string, title: string, notes: string|null, completed: boolean, due: string|null }[]>}
 */
export async function listReminders({ lists, includeCompleted = false } = {}, { run = runScript, timeoutMs } = {}) {
  const names = [...new Set((Array.isArray(lists) ? lists : lists ? [lists] : []).map(String).filter(Boolean))];
  if (!names.length) return [];
  const result = await run('reminders-list', { lists: names, includeCompleted: includeCompleted === true }, timeoutMs ? { timeoutMs } : {});
  return Array.isArray(result) ? result : [];
}

/**
 * @param {{ list: string, title: string, notes?: string }} item
 * @returns {Promise<{ id: string|null, list: string, title: string }>}
 */
export async function createReminder({ list, title, notes } = {}, { run = runScript, timeoutMs } = {}) {
  if (!list || typeof list !== 'string') throw new TypeError('createReminder needs a list name');
  if (!title || typeof title !== 'string') throw new TypeError('createReminder needs a title');
  const args = { list, title: title.slice(0, 500) };
  if (notes) args.notes = String(notes).slice(0, 4000);
  return run('reminders-create', args, timeoutMs ? { timeoutMs } : {});
}
