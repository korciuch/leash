// The MCP surface: tools register with zod schemas and answer over an in-memory transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, startupCheck, TOOL_SPECS } from '../src/server.mjs';

function fakeDeps() {
  const entries = [];
  const grant = { id: 'g_errands', name: 'Errands list', app: 'reminders', verbs: ['read', 'create'], records: { lists: ['Errands'] }, fields: ['*'], expiresAt: null };
  return {
    entries,
    deps: {
      gate: {
        grants: { activeGrants: () => [grant], addGrant: (g) => g },
        policy: {
          decide: (a) => (a.app === 'reminders' && (!a.target.list || a.target.list === 'Errands') ? { outcome: 'allow', grant, reason: 'Covered', clamp: { lists: ['Errands'] } } : { outcome: 'ask', reason: 'No grant covers this' }),
          grantFromApproval: () => null
        },
        filter: { filterReminders: (items) => ({ items, hidden: { records: 0, fields: [] } }) },
        ledger: { append: (e) => { entries.push(e); return e; }, verify: () => ({ entries: entries.length, intact: true }) }
      },
      apple: {
        reminders: { listReminders: async () => [{ id: 'r1', list: 'Errands', title: 'Milk' }], createReminder: async (q) => ({ id: 'r2', ...q }) },
        preflight: {
          warmUp: async () => [{ app: 'Calendar', ok: true, ms: 12 }],
          checkPermissions: async () => [{ app: 'Messages', ok: false, code: -1743, fix: 'Turn it on' }]
        }
      },
      dialog: { ask: async () => 'deny' },
      touchid: { verify: async () => ({ approved: false, code: 1 }) },
      drafts: {}
    }
  };
}

test('server registers every tool and answers calls', async () => {
  process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), 'leash-mcp-'));
  const { deps, entries } = fakeDeps();
  const { server } = createServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_SPECS).sort());
  const send = tools.find((t) => t.name === 'messages_send');
  assert.deepEqual(send.inputSchema.required.sort(), ['recipients', 'text', 'why']);
  assert.match(tools.find((t) => t.name === 'calendar_events').inputSchema.properties.why.description, /shows your reason/);
  assert.ok(!(tools.find((t) => t.name === 'leash_grants').inputSchema.required || []).includes('why'));
  for (const t of tools) assert.ok(!t.description.includes(String.fromCharCode(0x2014)));

  const noWhy = await client.callTool({ name: 'reminders_list', arguments: {} }).catch(() => ({ isError: true }));
  assert.equal(noWhy.isError, true);
  const r = await client.callTool({ name: 'reminders_list', arguments: { why: 'Plan errands for the week' } });
  assert.match(r.content[0].text, /Returned 1 reminder/);
  assert.equal(entries.at(-1).decision, 'allowed');

  const bad = await client.callTool({ name: 'messages_send', arguments: { text: 'x', why: 'Tell Sam I am late' } }).catch((e) => ({ isError: true, e }));
  assert.equal(bad.isError, true);

  await client.close();
});

test('startup check logs warm-up and permissions to the ledger', async () => {
  const { deps, entries } = fakeDeps();
  const origWrite = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    const res = await startupCheck(deps);
    assert.equal(res.ok, false);
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(entries.at(-1).tool, 'leash_start');
  assert.match(entries.at(-1).returned, /Messages permission off/);
  assert.ok(lines.some((l) => l.includes('Calendar: ok')));
});
