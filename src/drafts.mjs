// Leash drafts: emails the agent prepared. Nothing here sends anything.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { draftsPath, ensureHome } from './gate/paths.mjs';

/**
 * @typedef {{ id: string, to: string, subject: string, body: string, inReplyTo: string | null, createdAt: string, sentAt?: string }} Draft
 */

function load() {
  const file = draftsPath();
  if (!existsSync(file)) return { drafts: [] };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data.drafts) ? data : { drafts: [] };
  } catch {
    return { drafts: [] };
  }
}

function save(data) {
  ensureHome();
  const file = draftsPath();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2));
  renameSync(temp, file);
}

/** @returns {Draft} */
export function createDraft({ to, subject, body, inReplyTo = null }) {
  const data = load();
  const draft = {
    id: 'd_' + randomBytes(3).toString('hex'),
    to: String(to),
    subject: String(subject),
    body: String(body),
    inReplyTo: inReplyTo || null,
    createdAt: new Date().toISOString()
  };
  data.drafts.push(draft);
  save(data);
  return draft;
}

/** @returns {Draft | null} */
export function getDraft(id) {
  return load().drafts.find((d) => d.id === id) || null;
}

/** @returns {Draft[]} */
export function listDrafts() {
  return load().drafts;
}

/** @returns {Draft | null} */
export function markSent(id) {
  const data = load();
  const draft = data.drafts.find((d) => d.id === id);
  if (!draft) return null;
  draft.sentAt = new Date().toISOString();
  save(data);
  return draft;
}

/** Removes all drafts (used by `leash reset`). */
export function clearDrafts() {
  save({ drafts: [] });
}
