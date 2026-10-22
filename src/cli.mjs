#!/usr/bin/env node
// leash: manage grants and the ledger from the terminal.
import { activeGrants, loadGrants, revokeGrant, resetToSeed } from './gate/grants.mjs';
import { archive, tail, verify } from './gate/ledger.mjs';
import { clearDrafts } from './drafts.mjs';

const out = (line = '') => process.stdout.write(line + '\n');

function left(grant, now) {
  if (grant.revokedAt) return 'revoked';
  if (!grant.expiresAt) return 'this session';
  const ms = new Date(grant.expiresAt).getTime() - now.getTime();
  if (ms <= 0) return 'expired';
  return `${Math.max(1, Math.round(ms / 60000))} min left`;
}

function describe(grant, now) {
  const r = grant.records || {};
  const scope = [
    r.calendars && `calendars ${r.calendars.join(', ')}`,
    r.windowDays && `next ${r.windowDays} days`,
    r.lists && `lists ${r.lists.join(', ')}`,
    r.mailboxes && `mailboxes ${r.mailboxes.map((m) => `${m.account} / ${m.mailbox}`).join(', ')}`,
    r.sinceDays && `last ${r.sinceDays} days`,
    r.recipients && `to ${r.recipients.join(', ')}`
  ].filter(Boolean).join('; ');
  return `${grant.id.padEnd(16)} ${grant.name}: ${grant.app} [${grant.verbs.join(', ')}] ${scope}; fields ${grant.fields.join(', ')}; ${left(grant, now)}`;
}

const commands = {
  async grants(args) {
    const now = new Date();
    const list = args.includes('--all') ? await loadGrants() : await activeGrants(now);
    if (!list.length) return out('No active grants.');
    for (const g of list) out(describe(g, now));
  },
  async revoke([id]) {
    if (!id) throw new Error('Usage: leash revoke <grant id>');
    const g = await revokeGrant(id, 'cli');
    out(g ? `Revoked ${g.id} (${g.name}).` : `No grant with id ${id}.`);
    if (!g) process.exitCode = 1;
  },
  async reset() {
    const grants = await resetToSeed(new Date());
    await archive();
    clearDrafts();
    out(`Reset: ${grants.length} seed grants, fresh ledger, no drafts.`);
  },
  async log([n]) {
    const entries = await tail(Number(n) || 20);
    for (const e of entries) {
      out(`#${e.seq} ${e.time} ${e.tool} ${e.decision}${e.grantId ? ` (${e.grantId})` : ''}: ${e.summary} -> ${e.returned}`);
    }
    if (!entries.length) out('Ledger is empty.');
  },
  async verify() {
    const v = await verify();
    out(v.intact ? `Chain intact, ${v.entries} entries.` : `Chain broken at ${v.brokenAt} of ${v.entries} entries.`);
    if (!v.intact) process.exitCode = 1;
  },
  async preflight() {
    const { warmUp, checkPermissions } = await import('./apple/preflight.mjs');
    for (const w of await warmUp()) out(`${w.app}: ${w.ok ? 'ok' : 'failed'} in ${w.ms} ms${w.error ? `. ${w.error}` : ''}`);
    for (const p of await checkPermissions()) out(`${p.app} permission: ${p.ok ? 'on' : `off. ${p.fix || ''}`}`);
  }
};

const usage = 'Usage: leash grants [--all] | revoke <id> | reset | log [n] | verify | preflight';

const [name, ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  out(usage);
  process.exitCode = name && name !== 'help' ? 1 : 0;
} else {
  command(args).catch((error) => {
    process.stderr.write(`${error && error.message || error}\n`);
    process.exitCode = 1;
  });
}
