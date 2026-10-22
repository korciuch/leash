#!/usr/bin/env node
// Spike 04: the full chain Claude Desktop -> node (this server) -> osascript / dialog / Touch ID.
// Answers: which app do macOS prompts name, do approvals survive a relaunch, do dialogs and
// Touch ID appear when the caller is Claude Desktop? Every call is written to a hash-chained log.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const ledgerDir = join(homedir(), '.leash-spike');
const ledgerPath = join(ledgerDir, 'ledger.jsonl');
mkdirSync(ledgerDir, { recursive: true });

function lastHash() {
  if (!existsSync(ledgerPath)) return 'genesis';
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)).hash : 'genesis';
}

function log(entry) {
  const body = { time: new Date().toISOString(), ...entry, prev: lastHash() };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  appendFileSync(ledgerPath, JSON.stringify({ ...body, hash }) + '\n');
}

function explain(stderr) {
  const text = String(stderr || '').trim();
  if (text.includes('-1743')) return 'macOS is blocking this process from controlling the app. Turn it on in System Settings > Privacy & Security > Automation.';
  if (text.includes('-1712')) return 'The app took too long to answer.';
  return text || 'Apple Event request failed';
}

async function jxa(script, args = []) {
  const started = Date.now();
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: 70000, maxBuffer: 1024 * 1024 });
    return { ok: true, ms: Date.now() - started, output: stdout.trim() };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: explain(error.stderr) };
  }
}

async function processChain() {
  const chain = [];
  let pid = process.pid;
  for (let i = 0; i < 6 && pid > 1; i += 1) {
    try {
      const { stdout } = await run('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
      const line = stdout.trim();
      const space = line.indexOf(' ');
      const ppid = Number(line.slice(0, space));
      chain.push({ pid, command: line.slice(space + 1).trim() });
      pid = ppid;
    } catch {
      break;
    }
  }
  return chain;
}

const CALENDAR_NAMES = "function run() { return JSON.stringify(Application('Calendar').calendars.name()); }";
const ASK = "function run(argv) { const app = Application.currentApplication(); app.includeStandardAdditions = true; app.activate(); try { const r = app.displayDialog(argv[0], {withTitle: 'Leash', buttons: ['Deny', 'Allow once', 'Allow for 1 hour'], defaultButton: 'Deny', withIcon: 'caution', givingUpAfter: 60}); return r.gaveUp ? 'Deny (timed out)' : r.buttonReturned; } catch (e) { return 'Deny (closed)'; } }";

const reply = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const server = new McpServer({ name: 'leash-spike', version: '0.0.1' });

server.registerTool(
  'spike_whoami',
  { description: 'Show the chain of processes that launched this server, to see which app macOS will name in permission prompts.', inputSchema: {} },
  async () => {
    const chain = await processChain();
    log({ tool: 'spike_whoami', decision: 'allowed' });
    return reply({ node: process.execPath, chain });
  }
);

server.registerTool(
  'spike_calendar_names',
  { description: 'Read the names of the Calendar calendars through osascript. Used to test the Automation permission prompt and whether it sticks after relaunching Claude.', inputSchema: {} },
  async () => {
    const result = await jxa(CALENDAR_NAMES);
    log({ tool: 'spike_calendar_names', decision: result.ok ? 'allowed' : 'failed', ms: result.ms });
    return reply(result);
  }
);

server.registerTool(
  'spike_ask',
  {
    description: 'Show the Leash approval dialog on the Mac and return what the person chose. The agent cannot answer it.',
    inputSchema: { action: z.string().max(400).default('Claude wants to send a Messages text to 14 contacts: "Check out this link". No permission covers this.') }
  },
  async ({ action }) => {
    const result = await jxa(ASK, [action]);
    log({ tool: 'spike_ask', decision: result.ok ? result.output : 'failed', ms: result.ms });
    return reply(result.ok ? { decision: result.output, secondsOpen: Math.round(result.ms / 1000) } : result);
  }
);

server.registerTool(
  'spike_touchid',
  {
    description: 'Ask for Touch ID through the Leash helper binary (path in LEASH_TOUCHID) and return approved or denied.',
    inputSchema: { reason: z.string().max(200).default('send an email as you to alex@example.com') }
  },
  async ({ reason }) => {
    const helper = process.env.LEASH_TOUCHID;
    if (!helper || !existsSync(helper)) return reply({ ok: false, error: 'Set LEASH_TOUCHID to the compiled helper path.' });
    const started = Date.now();
    let outcome;
    try {
      const { stdout } = await run(helper, [reason], { timeout: 70000 });
      outcome = { approved: true, output: stdout.trim() };
    } catch (error) {
      outcome = { approved: false, exitCode: error.code, output: String(error.stdout || '').trim() };
    }
    log({ tool: 'spike_touchid', decision: outcome.approved ? 'approved' : 'denied', ms: Date.now() - started });
    return reply({ ...outcome, ms: Date.now() - started });
  }
);

server.registerTool(
  'spike_verify_log',
  { description: 'Check that the hash chain of the spike log is intact.', inputSchema: {} },
  async () => {
    if (!existsSync(ledgerPath)) return reply({ entries: 0, intact: true });
    const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let prev = 'genesis';
    for (const [index, entry] of lines.entries()) {
      const { hash, ...body } = entry;
      const expected = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if (entry.prev !== prev || hash !== expected) return reply({ entries: lines.length, intact: false, brokenAt: index });
      prev = hash;
    }
    return reply({ entries: lines.length, intact: true, path: ledgerPath });
  }
);

await server.connect(new StdioServerTransport());
