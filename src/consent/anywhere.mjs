// Ask the person on the Mac and on their phone at once. First answer wins.
// The Mac dialog and an iMessage link to the phone page (served by the viewer) race against a 60 s timeout.
// Phone wins: the dialog's osascript child is killed. Timeout: deny. A failed phone text never fails the call.
import * as approvalsStore from '../approvals.mjs';
import { randomInt } from 'node:crypto';
import { createReplyWatcher } from './replies.mjs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { leashHome, ensureHome } from '../gate/paths.mjs';

function note(msg) {
  try { ensureHome(); appendFileSync(join(leashHome(), 'phone.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}

const lowerFirst = (s) => String(s || '').replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());

/**
 * @param {object} deps
 * @param {{ start?: Function, ask?: Function }} deps.dialog  consent/dialog.mjs (start() is cancellable)
 * @param {Function} [deps.sendText]  apple/messages.mjs sendText
 * @param {object} [deps.approvals]  approvals.mjs
 * @param {string} [deps.phone]  iMessage handle for the phone; default LEASH_PHONE at call time
 * @param {string} [deps.agentName]
 * @param {number} [deps.timeoutSec]  default 60
 * @param {number} [deps.pollMs]  default 400
 * @param {(msg: string) => void} [deps.log]
 */
export function createAskAnywhere(deps = {}) {
  const store = deps.approvals || approvalsStore;
  const log = deps.log || ((msg) => process.stderr.write(`[leash] ${msg}\n`));
  const pollMs = deps.pollMs || 400;
  const agentName = deps.agentName || 'Claude';

  /**
   * @param {{ action: object, why?: string, message: string, detail?: string, timeoutSec?: number }} req
   * @returns {Promise<{ choice: 'deny'|'once'|'hour', decidedBy: 'mac'|'phone'|'timeout', approvalId: string, phoneSent: boolean, phoneError: string|null }>}
   */
  return async function askAnywhere({ action = {}, why, message, detail, timeoutSec = deps.timeoutSec || 60 }) {
    const { id, token } = store.createApproval({
      tool: action.tool, app: action.app, verb: action.verb, summary: action.summary, why, detail, agent: agentName, ttlMs: timeoutSec * 1000
    });
    const url = store.approvalUrl(id, token);
    const code = String(randomInt(1000, 10000));
    const startedAt = new Date();
    const phone = deps.phone !== undefined ? deps.phone : (process.env.LEASH_PHONE || '').trim();
    const status = { phoneSent: false, phoneError: null };
    note(`approval ${id}: phone=${phone ? phone : '(none: LEASH_PHONE not set)'} sendText=${typeof deps.sendText}`);

    const phoneFirst = phone && typeof deps.sendText === 'function'
      ? (deps.phoneFirstSec !== undefined ? deps.phoneFirstSec : Number(process.env.LEASH_PHONE_FIRST_SEC || 0))
      : 0;
    const macText = phone ? `${message}\n\nNo answer from your phone yet.` : message;
    const dialog = deps.dialog || {};
    const openDialog = (secs) => (typeof dialog.start === 'function'
      ? dialog.start({ message: macText, timeoutSec: secs })
      : { result: Promise.resolve().then(() => dialog.ask({ message: macText, timeoutSec: secs })), cancel() {} });
    let handle = { result: new Promise(() => {}), cancel() {} };
    let dialogTimer = null;
    let openNow = () => {};

    if (phone && typeof deps.sendText === 'function') {
      const lines = [`Leash: ${agentName} wants to ${lowerFirst(action.summary)}.`];
      if (why) lines.push(`Why (agent's words): "${why}"`);
      lines.push(`Reply YES ${code} or NO ${code}`);
      Promise.resolve()
        .then(() => deps.sendText({ recipients: [phone], text: lines.join('\n') }))
        .then((r) => { Promise.resolve().then(() => deps.sendText({ recipients: [phone], text: `Or open: ${url}` })).catch(() => {}); return r; })
        .then((r) => { status.phoneSent = true; note(`approval ${id}: alert sent ${JSON.stringify(r)}`); })
        .catch((error) => {
          status.phoneError = String((error && error.message) || error);
          note(`approval ${id}: alert FAILED ${status.phoneError}`);
          openNow();
          log(`phone approval text failed, the Mac dialog still works: ${status.phoneError}${error && error.fix ? `. ${error.fix}` : ''}`);
        });
    }

    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      let poller = null;
      const finish = (choice, decidedBy) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(dialogTimer);
        clearInterval(poller);
        if (decidedBy !== 'mac') handle.cancel();
        resolve({ choice: choice === 'once' || choice === 'hour' ? choice : 'deny', decidedBy, approvalId: id, ...status });
      };
      const settleFrom = (result, fallbackBy) => {
        if (result.ok) return finish(result.approval.choice, result.approval.decidedBy);
        const a = result.approval;
        if (a && a.decidedBy) return finish(a.choice, a.decidedBy);
        return finish('deny', fallbackBy);
      };

      const startDialog = () => {
        if (done) return;
        handle = openDialog(Math.max(5, timeoutSec - phoneFirst + 5));
        Promise.resolve(handle.result).then(
          (choice) => { if (!done) settleFrom(store.markDecided(id, choice, 'mac'), 'mac'); },
          () => { if (!done) settleFrom(store.markDecided(id, 'deny', 'mac'), 'mac'); }
        );
      };
      let opened = false;
      const startOnce = () => { if (opened) return; opened = true; clearTimeout(dialogTimer); startDialog(); };
      openNow = startOnce;
      if (phoneFirst > 0 && !status.phoneError) dialogTimer = setTimeout(startOnce, phoneFirst * 1000);
      else startOnce();
      const makeWatcher = deps.createReplyWatcher || createReplyWatcher;
      const watchReplies = phone && deps.replies !== false ? makeWatcher({ code, since: startedAt, log }) : null;
      let lastReplyCheck = 0;
      poller = setInterval(() => {
        const a = store.getApproval(id);
        if (a && a.decidedBy && a.decidedBy !== 'mac') return finish(a.choice, a.decidedBy);
        if (!watchReplies || Date.now() - lastReplyCheck < 1000) return;
        lastReplyCheck = Date.now();
        Promise.resolve(watchReplies()).then((reply) => {
          if (!reply || done) return;
          log(`iMessage reply from ${reply.handle}: ${reply.choice}`);
          settleFrom(store.markDecided(id, reply.choice, 'phone'), 'phone');
        }, () => {});
      }, pollMs);
      timer = setTimeout(() => settleFrom(store.markDecided(id, 'deny', 'timeout'), 'timeout'), timeoutSec * 1000);
    });
  };
}
