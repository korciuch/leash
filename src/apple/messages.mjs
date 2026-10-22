// Messages adapter: iMessage texts. Only ever called after explicit human approval.
import { runScript } from './jxa.mjs';

/**
 * @param {{ recipients: string[], text: string }} message
 * @returns {Promise<{ sent: number, failed?: { recipient: string, message: string }[] }>}
 */
export async function sendText({ recipients, text } = {}, { run = runScript, timeoutMs = 60000 } = {}) {
  const list = [...new Set((Array.isArray(recipients) ? recipients : [recipients]).map((r) => String(r ?? '').trim()).filter(Boolean))];
  if (!list.length) throw new TypeError('sendText needs at least one recipient');
  if (!text || typeof text !== 'string') throw new TypeError('sendText needs text');
  const result = await run('messages-send', { recipients: list, text }, { timeoutMs });
  const sent = Number(result && result.sent) || 0;
  const failed = Array.isArray(result && result.failed) ? result.failed : [];
  return failed.length ? { sent, failed } : { sent };
}
