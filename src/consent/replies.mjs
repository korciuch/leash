// Read iMessage replies to a Leash approval ("yes 4821" / "no 4821") from the Messages database.
// Needs Full Disk Access for the process running Leash. Counts replies typed on the person's own Apple Account
// (any of their devices) or from allowed handles: LEASH_APPROVERS (comma-separated), default LEASH_PHONE.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLE_EPOCH_S = 978307200;
const REPLY = /^\s*(yes|y|approve|approved|ok|no|n|deny|denied)\W{0,3}(\d{4})\s*\W*$/i;

/** Phone numbers compare by their last 10 digits, emails case-insensitively. */
export function normalizeHandle(handle) {
  const h = String(handle || '').trim().toLowerCase();
  if (!h) return '';
  if (h.includes('@')) return h;
  const digits = h.replace(/\D/g, '');
  return digits.slice(-10);
}

export function allowedHandles(env = process.env) {
  const raw = (env.LEASH_APPROVERS || env.LEASH_PHONE || '').split(',');
  return raw.map(normalizeHandle).filter(Boolean);
}

/** Pull the visible text out of an attributedBody blob (an NSArchiver stream): the first readable run after NSString. */
export function textFromAttributedBody(hex) {
  if (!hex) return '';
  const s = Buffer.from(hex, 'hex').toString('utf8');
  const at = s.indexOf('NSString');
  const tail = at >= 0 ? s.slice(at + 8) : s;
  const m = /[\x20-\x7e -￿][^\x00-\x08\x0e-\x1f]{0,1999}/.exec(tail.replace(/^[^+]*\+/, ''));
  return m ? m[0].replace(/[\x00-\x1f]+.*$/s, '').trim() : '';
}

/** @returns {{ choice: 'deny'|'once', code: string } | null} */
export function parseReply(text) {
  const m = REPLY.exec(String(text || ''));
  if (!m) return null;
  return { choice: /^(no|n|deny|denied)$/i.test(m[1]) ? 'deny' : 'once', code: m[2] };
}

const defaultRun = (args) => new Promise((resolve, reject) => {
  execFile('/usr/bin/sqlite3', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim()));
    else resolve(stdout);
  });
});

/**
 * Create a checker for one approval code. Call it repeatedly; it resolves to a decision or null.
 * @param {{ code: string, since: Date, allowed?: string[], db?: string, run?: Function, log?: Function }} opts
 */
export function createReplyWatcher({ code, since, allowed = allowedHandles(), db = join(homedir(), 'Library', 'Messages', 'chat.db'), run = defaultRun, log = () => {} }) {
  let disabled = false;
  let busy = false;
  const sinceNs = (BigInt(Math.floor(since.getTime() / 1000) - APPLE_EPOCH_S - 5) * 1000000000n).toString();
  const sql = `SELECT m.ROWID, COALESCE(h.id, ''), m.is_from_me, hex(COALESCE(m.text, '')), hex(m.attributedBody) FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID WHERE m.date > ${sinceNs} ORDER BY m.ROWID DESC LIMIT 40;`;
  return async function check() {
    if (disabled || busy) return null;
    busy = true;
    try {
      const out = await run(['-readonly', '-separator', '|', db, sql]);
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [, handle, fromMe, textHex, bodyHex] = line.split('|');
        let text = textHex ? Buffer.from(textHex, 'hex').toString('utf8') : '';
        if (!text) text = textFromAttributedBody(bodyHex);
        if (!text || text.includes('Leash:')) continue;
        const reply = parseReply(text);
        if (!reply || reply.code !== code) continue;
        const who = normalizeHandle(handle);
        if (fromMe === '1' || (who && allowed.includes(who))) {
          return { choice: reply.choice, handle: handle || 'me' };
        }
      }
      return null;
    } catch (error) {
      disabled = true;
      log(`reading iMessage replies failed (give the app running Leash Full Disk Access to enable it): ${error.message}`);
      return null;
    } finally {
      busy = false;
    }
  };
}
