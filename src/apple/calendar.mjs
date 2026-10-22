// Calendar adapter: events from named calendars only.
import { runScript } from './jxa.mjs';

const DAY_MS = 864e5;

function toIso(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback.toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Not a date: ${String(value)}`);
  return date.toISOString();
}

/**
 * @param {{ calendars: string[], from?: string|Date, to?: string|Date }} query
 * @param {{ run?: typeof runScript, timeoutMs?: number }} [opts]
 * @returns {Promise<{ id: string, calendar: string, title: string, start: string, end: string, location: string|null, notes: string|null }[]>}
 */
export async function listEvents({ calendars, from, to } = {}, { run = runScript, timeoutMs } = {}) {
  const names = [...new Set((Array.isArray(calendars) ? calendars : calendars ? [calendars] : []).map(String).filter(Boolean))];
  if (!names.length) return [];
  const now = new Date();
  const fromIso = toIso(from, now);
  const toIsoValue = toIso(to, new Date(new Date(fromIso).getTime() + 7 * DAY_MS));
  const result = await run('calendar-events', { calendars: names, from: fromIso, to: toIsoValue }, timeoutMs ? { timeoutMs } : {});
  return Array.isArray(result) ? result : [];
}
