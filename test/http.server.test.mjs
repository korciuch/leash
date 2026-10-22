// Leash over Streamable HTTP: bearer auth, then a real SDK client can initialize, list tools and call one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start, authorized, AGENT } from '../src/http.mjs';
import { TOOL_SPECS } from '../src/server.mjs';

const TOKEN = 'test-token-0123456789abcdefghij';

function fakeDeps() {
  const entries = [];
  const grant = { id: 'g_errands', name: 'Errands list', app: 'reminders', verbs: ['read', 'create'], records: { lists: ['Errands'] }, fields: ['*'], expiresAt: null };
  return {
    entries,
    deps: {
      gate: {
        grants: { activeGrants: () => [grant], addGrant: (g) => g },
        policy: {
          decide: () => ({ outcome: 'allow', grant, reason: 'Covered', clamp: { lists: ['Errands'] } }),
          grantFromApproval: () => null
        },
        filter: { filterReminders: (items) => ({ items, hidden: { records: 0, fields: [] } }) },
        ledger: { append: (e) => { entries.push(e); return e; }, verify: () => ({ entries: entries.length, intact: true }) }
      },
      apple: { reminders: { listReminders: async () => [{ id: 'r1', list: 'Errands', title: 'Milk' }] } },
      dialog: { ask: async () => 'deny' },
      touchid: { verify: async () => ({ approved: false, code: 1 }) },
      drafts: {}
    }
  };
}

test('authorized compares bearer tokens', () => {
  assert.equal(authorized(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(authorized(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(authorized(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(authorized(TOKEN, TOKEN), false);
  assert.equal(authorized(undefined, TOKEN), false);
});

test('refuses to start without a long token', async () => {
  await assert.rejects(start({ token: 'short', port: 0, host: '127.0.0.1', deps: fakeDeps().deps }), /at least 24/);
  await assert.rejects(start({ token: '', port: 0, host: '127.0.0.1', deps: fakeDeps().deps }), /LEASH_HTTP_TOKEN/);
});

test('HTTP transport: 401 without token, then initialize, list tools and call leash_grants', async () => {
  process.env.LEASH_HOME = mkdtempSync(join(tmpdir(), 'leash-http-'));
  const { deps, entries } = fakeDeps();
  const srv = await start({ token: TOKEN, port: 0, host: '127.0.0.1', deps });
  try {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const noAuth = await fetch(srv.url, { method: 'POST', headers, body: JSON.stringify(init) });
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(srv.url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong-token-wrong-token-wrong' }, body: JSON.stringify(init) });
    assert.equal(badAuth.status, 401);
    const getNoAuth = await fetch(srv.url);
    assert.equal(getNoAuth.status, 401);

    const transport = new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
    const client = new Client({ name: 'claude-code-test', version: '0.0.0' });
    await client.connect(transport);
    assert.ok(transport.sessionId);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_SPECS).sort());

    const r = await client.callTool({ name: 'leash_grants', arguments: {} });
    assert.ok(!r.isError);
    assert.match(r.content[0].text, /Errands list/);

    const list = await client.callTool({ name: 'reminders_list', arguments: { why: 'Plan errands for the week' } });
    assert.match(list.content[0].text, /Milk|1 reminder/);
    assert.ok(entries.length > 0);
    for (const e of entries) assert.equal(e.agent, AGENT);

    await transport.terminateSession();
    await client.close();
  } finally {
    await srv.close();
  }
});
