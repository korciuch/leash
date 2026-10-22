// Messages adapter: iMessage texts. Only ever called after explicit human approval.
import { runScript, AppleError } from './jxa.mjs';

export const NO_IMESSAGE_FIX = 'Messages is not signed in to iMessage. Open Messages > Settings > iMessage and sign in.';
const NOT_SENT_FIX = 'Check that each recipient is a phone number or email that uses iMessage, and that Messages can send to it by hand.';

/** Turn script errors into Messages-specific AppleErrors (never the generic calendar or mailbox hint). */
export function messagesError(error) {
  if (!error || typeof error !== 'object') return error;
  const text = String(error.message || '');
  if (error.code === 'no_imessage' || /not signed in to iMessage|No iMessage account/i.test(text)) {
    return new AppleError({ app: 'Messages', code: 'no_imessage', message: 'Messages is not signed in to iMessage', fix: NO_IMESSAGE_FIX });
  }
  if (error.code === 'not_sent' || error.code === -1728 || /^No text was sent/.test(text)) {
    return new AppleError({ app: 'Messages', code: error.code === -1728 ? -1728 : 'not_sent', message: text || 'No text was sent', fix: NOT_SENT_FIX });
  }
  return error;
}

/**
 * @param {{ recipients: string[], text: string }} message
 * @returns {Promise<{ sent: number, failed?: { recipient: string, message: string }[] }>}
 */
export async function sendText({ recipients, text } = {}, { run = runScript, timeoutMs = 60000 } = {}) {
  const list = [...new Set((Array.isArray(recipients) ? recipients : [recipients]).map((r) => String(r ?? '').trim()).filter(Boolean))];
  if (!list.length) throw new TypeError('sendText needs at least one recipient');
  if (!text || typeof text !== 'string') throw new TypeError('sendText needs text');
  let result;
  try {
    result = await run('messages-send', { recipients: list, text }, { timeoutMs });
  } catch (error) {
    throw messagesError(error);
  }
  const sent = Number(result && result.sent) || 0;
  const failed = Array.isArray(result && result.failed) ? result.failed : [];
  return failed.length ? { sent, failed } : { sent };
}
