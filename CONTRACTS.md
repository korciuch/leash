# Leash build contracts (hackathon day, due 5:00 PM)

Leash is a local MCP server that sits between an AI agent (Claude Desktop) and the Mac's Calendar, Reminders, Mail and Messages. Every call is checked against a scoped, expiring grant; anything outside a grant raises a native macOS approval dialog; sends need Touch ID even inside a grant; every result is filtered to the grant's records and fields before the model sees it; every call lands in a hash-chained ledger. A local web viewer shows active grants (with countdowns and a Revoke button) and the live ledger.

Plain ESM JavaScript (`.mjs`), Node 20+, no build step, no TypeScript. JSDoc types are welcome. Dependencies: only `@modelcontextprotocol/sdk` 1.32.1 and `zod` ^4.4.3 (already in package.json); everything else from the Node standard library. Tests use `node:test` + `node:assert/strict`, live in `test/`, and must pass on Linux (no macOS needed): anything that would call osascript or the Touch ID helper takes an injectable path/function so tests use fakes.

Writing rules for all user-facing text (dialogs, tool descriptions, viewer, docs): plain, short, specific; never use the em dash character; use colons, commas or periods instead.

## Lanes and file ownership (write only your own files)

| Lane | Owns |
| --- | --- |
| A Gate | `src/gate/grants.mjs`, `src/gate/policy.mjs`, `src/gate/filter.mjs`, `src/gate/ledger.mjs`, `src/gate/paths.mjs`, `test/gate.*.test.mjs` |
| B Apple | `src/apple/jxa.mjs`, `src/apple/scripts/*.js`, `src/apple/calendar.mjs`, `src/apple/reminders.mjs`, `src/apple/mail.mjs`, `src/apple/messages.mjs`, `src/apple/preflight.mjs`, `test/apple.*.test.mjs`, `test/fixtures/fake-osascript*` |
| C Server | `src/server.mjs`, `src/tools.mjs`, `src/drafts.mjs`, `src/consent/dialog.mjs`, `src/consent/touchid.mjs`, `src/cli.mjs`, `helper/Leash.swift`, `test/server.*.test.mjs` |
| D Viewer | `src/viewer/server.mjs`, `src/viewer/index.html`, `test/viewer.*.test.mjs` |
| E Story | `docs/devpost.md`, `docs/demo-script.md`, `docs/seed-emails.md` |

If you need something from another lane before it exists, code against the contract below (stub it locally inside your own test if needed). Do not edit another lane's files.

## Data directory

`LEASH_HOME` env var, default `~/.leash`. `src/gate/paths.mjs` exports `leashHome()`, `grantsPath()`, `ledgerPath()`, `draftsPath()` (all read `process.env.LEASH_HOME` at call time) and `ensureHome()`.

- `grants.json`: `{ "grants": [Grant, ...] }`, written atomically (write temp file, rename). Re-read from disk on every call, because the viewer revokes grants from another process.
- `ledger.jsonl`: one JSON object per line, append only.
- `drafts.json`: `{ "drafts": [Draft, ...] }` (Lane C).

## Types

```js
// Risk tiers: read 0, create/draft 1, modify 2, send/delete 3.
Verb = 'read' | 'create' | 'draft' | 'modify' | 'send' | 'delete'
App  = 'calendar' | 'reminders' | 'mail' | 'messages'

Grant = {
  id: string,                 // short, e.g. 'g_plan_week' or random 'g_ab12cd'
  name: string,               // 'Plan the week'
  app: App,
  verbs: Verb[],
  records: {                  // what the grant covers; omitted keys mean "none", never "all"
    calendars?: string[],     // calendar names, e.g. ['Leash Demo']
    windowDays?: number,      // events from now to now + windowDays
    lists?: string[],         // reminders lists, e.g. ['Errands']
    mailboxes?: { account: string, mailbox: string }[],  // e.g. [{ account: 'Alumni', mailbox: 'Leash Demo' }]
    sinceDays?: number,       // mail received in the last N days
    recipients?: string[]     // for send verbs: allowed recipients; omitted = none
  },
  fields: string[],           // e.g. ['title','start','end'] or ['*']
  expiresAt: string | null,   // ISO time; null = until the server stops ("this session")
  createdAt: string,
  revokedAt?: string,
  source: 'seed' | 'dialog' | 'cli' | 'viewer'
}

Action = {
  tool: string,               // MCP tool name, e.g. 'calendar_events'
  app: App,
  verb: Verb,
  target: {                   // what the call wants to touch
    calendars?: string[], from?: string, to?: string,
    list?: string,
    account?: string, mailbox?: string, messageId?: string,
    recipients?: string[]
  },
  summary: string             // plain English for the dialog and ledger: 'Send a Messages text to 14 contacts: "Check out this link"'
}

Decision = {
  outcome: 'allow' | 'ask' | 'touchid' | 'deny',
  grant?: Grant,              // the grant that covers it, if any
  reason: string,             // plain English, e.g. 'Covered by "Plan the week"', 'No grant covers Messages'
  clamp?: {                   // limits pushed into the script inputs (only what the grant allows)
    calendars?: string[], from?: string, to?: string,
    lists?: string[],
    mailboxes?: { account, mailbox }[], sinceDays?: number
  }
}

LedgerEntry = {
  seq: number, time: string, agent: string, tool: string, app: App, verb: Verb,
  grantId: string | null, decision: string,   // 'allowed' | 'denied' | 'approved once' | 'approved 1 hour' | 'touchid approved' | 'touchid denied' | 'failed' | 'expired'
  summary: string, records: string[],         // record ids touched
  returned: string,                           // short description: '5 events (title, start, end)'
  prev: string, hash: string                  // sha256 over the entry without `hash`; prev = previous hash or 'genesis'
}
```

## Lane A: Gate (`src/gate/*`)

- `grants.mjs`
  - `loadGrants()` → Grant[] (all, including expired and revoked); creates the file with `seedGrants()` if missing.
  - `activeGrants(now = new Date())` → Grant[] not revoked and not expired.
  - `addGrant(partial)` → Grant (fills id, createdAt).
  - `revokeGrant(id, by = 'cli')` → Grant | null.
  - `resetToSeed(now = new Date())` → Grant[]: rewrites the file with fresh seed grants (used before each rehearsal).
  - `seedGrants(now)` → the three demo grants:
    1. `g_plan_week` "Plan the week": calendar, verbs [read], calendars ['Leash Demo'], windowDays 7, fields ['title','start','end'], expires now + 1 hour.
    2. `g_draft_replies` "Draft replies": mail, verbs [read, draft, send], mailboxes [{account: 'Alumni', mailbox: 'Leash Demo'}], sinceDays 30, fields ['from','subject','date','body'], expires now + 1 hour. Send stays top tier, so Touch ID every time.
    3. `g_errands` "Errands list": reminders, verbs [read, create], lists ['Errands'], fields ['*'], expiresAt null (this session).
    Account and calendar names come from env when set: `LEASH_MAIL_ACCOUNT` (default 'Alumni'), `LEASH_MAIL_MAILBOX` ('Leash Demo'), `LEASH_CALENDAR` ('Leash Demo'), `LEASH_ERRANDS` ('Errands').
- `policy.mjs`
  - `tierOf(verb)` → 0..3.
  - `decide(action, grants, now = new Date())` → Decision. Rules, in order:
    1. Find active grants with the same app whose verbs include the action's verb and whose records cover the target (calendar names subset of grant calendars, or no calendar given → clamp to the grant's calendars; list in grant lists; mailbox in grant mailboxes; recipients subset of grant recipients when the grant lists recipients, otherwise for mail send: any recipient is covered only if the grant has verb send).
    2. Covered and tier < 3 → `allow` with `clamp` (date window clamped to now..now+windowDays; requested range intersected).
    3. Covered and tier 3 → `touchid`.
    4. Not covered → `ask` (the server shows the dialog; after approval, tier 3 still needs Touch ID, which the server handles).
    5. `deny` only for things Leash never allows (e.g. app unknown).
  - `grantFromApproval(action, choice, now)` → Grant for "Allow for 1 hour" (scoped to exactly that action's app, verb and target; source 'dialog'), or null for once/deny.
- `filter.mjs`
  - `filterEvents(events, grant, clamp)`: keep events whose calendar is in the grant and that overlap the clamp window; keep only granted fields plus `id` and `calendar`. Field names on events: `title, start, end, location, notes`.
  - `filterReminders(items, grant)`: keep items in granted lists; fields on reminders: `title, notes, completed, due`.
  - `filterMessages(messages, grant)`: keep messages in granted mailboxes and within sinceDays; fields on messages: `from, to, subject, date, body`.
  - Each returns `{ items, hidden: { records: n, fields: [names removed] } }` so the server can say "3 events hidden, notes and location withheld".
- `ledger.mjs`
  - `append(partial)` → LedgerEntry (adds seq, time, prev, hash; agent defaults to 'claude').
  - `readAll()` → LedgerEntry[]; `tail(n)`.
  - `verify()` → `{ entries, intact, brokenAt? }`.
  - `archive()` → moves the current ledger to `ledger.<timestamp>.jsonl` and starts fresh (for rehearsals; append-only per file).

## Lane B: Apple (`src/apple/*`)

All Apple access goes through fixed JXA scripts in `src/apple/scripts/` run with `/usr/bin/osascript -l JavaScript <file> <json-args>`; scripts take one JSON argument and print one JSON value. Never build scripts from strings with user input.

- `jxa.mjs`: `runScript(name, args, { timeoutMs = 30000 } = {})` → parsed JSON. osascript path from `process.env.LEASH_OSASCRIPT` or `/usr/bin/osascript` (tests point it at a fake). Errors throw `AppleError { app, code, message, fix }` with plain-English fixes: -1743 (Automation off: "Turn on System Settings > Privacy & Security > Automation > node > <App>"), -1712 (timed out), -1728 (not found: check the calendar, list or mailbox name), -1719 (invalid index), -600 (app not running).
- `calendar.mjs`: `listEvents({ calendars, from, to })` → `[{ id, calendar, title, start, end, location, notes }]`. Must look up only the named calendars by name (never iterate all calendars: big synced calendars cost 1 to 6 s each).
- `reminders.mjs`: `listReminders({ lists, includeCompleted = false })` → `[{ id, list, title, notes, completed, due }]`; `createReminder({ list, title, notes })` → `{ id, list, title }`.
- `mail.mjs`: `listMessages({ account, mailbox, sinceDays, limit = 20 })` → `[{ id, account, mailbox, from, subject, date, read }]` (clamp to the mailbox's message count: slicing past it throws -1719; `account` 'On My Mac' or 'local' means `Mail.mailboxes`); `readMessage({ account, mailbox, id })` → `{ id, account, mailbox, from, to, subject, date, body }`; `sendMessage({ to, subject, body })` → `{ sent: true }` (outgoing message, visible false, then send).
- `messages.mjs`: `sendText({ recipients, text })` → `{ sent: n }` via the Messages app (iMessage service). Only ever called after explicit approval.
- `preflight.mjs`: `warmUp(apps = ['Calendar','Reminders','Mail'])` → `[{ app, ok, ms, error? }]` (launch each app and make one trivial call); `checkPermissions()` → `[{ app, ok, code?, fix? }]` naming exactly which Automation permission is off.

Reference: the working spike scripts in `docs/spike-01-read-timing.js` (reads, timings, error codes) and `docs/spike-00-seed-demo.js` (creates calendars, events, reminders). Demo data on the Mac: calendars "Leash Demo" (5 work events, notes contain a fake door code and PIN that must never reach the model) and "Leash Personal" (2 private events, not granted), Reminders list "Errands" (3 items), Mail account "Alumni" with a Gmail label "Leash Demo".

## Lane C: Server (`src/server.mjs`, `src/tools.mjs`, `src/consent/*`, `src/drafts.mjs`, `src/cli.mjs`)

- `consent/dialog.mjs`: `ask({ message, timeoutSec = 60 })` → `'deny' | 'once' | 'hour'` using the JXA dialog from `docs/spike-02-approval-dialog.js` (title Leash, buttons Deny / Allow once / Allow for 1 hour, default Deny, caution icon, gives up → deny). Injectable runner for tests.
- `consent/touchid.mjs`: `verify(reason)` → `{ approved, code }` by running the helper at `process.env.LEASH_TOUCHID` (default `<repo>/helper/Leash`); exit 0 approved, 1 denied, 2 unavailable. `helper/Leash.swift` is the spike 03 helper (already copied); build with `swiftc helper/Leash.swift -o helper/Leash`.
- `drafts.mjs`: `createDraft({ to, subject, body, inReplyTo })` → Draft `{ id, to, subject, body, inReplyTo, createdAt, sentAt? }`, `getDraft(id)`, `listDrafts()`, `markSent(id)`.
- `tools.mjs`: one function per tool, each following the same pipeline: build Action → `policy.decide` → if ask: `dialog.ask` (deny → ledger 'denied' and a plain refusal to the model; hour → `addGrant(grantFromApproval(...))`) → if tier 3: `touchid.verify` → call the Apple adapter with the clamp → filter → `ledger.append` → reply text that says what was returned and what was withheld. Tools:
  - `leash_grants`: list active grants with time left, plus "what you can do" in one line each.
  - `calendar_events({ from?, to?, calendar? })`
  - `reminders_list({ list? })`, `reminders_add({ list, title, notes? })`
  - `mail_list({ mailbox?, account? })`, `mail_read({ id, mailbox?, account? })`
  - `mail_draft({ to, subject, body, inReplyTo? })` (verb draft, stores a Leash draft, nothing sent)
  - `mail_send({ draftId })` (verb send: Touch ID with the reason "send an email as you to <to>: <subject>")
  - `messages_send({ recipients, text })` (verb send; no seeded grant covers Messages, so it raises the dialog)
  - `leash_verify_log`
  Tool descriptions tell the agent plainly that Leash enforces grants and that refusals are final for that call.
- `server.mjs`: McpServer name 'leash', stdio transport, registers the tools with zod schemas, runs `preflight.warmUp` and `checkPermissions` in the background at start and logs the result to stderr (and the ledger as tool 'leash_start').
- `cli.mjs`: `leash grants`, `leash revoke <id>`, `leash reset` (resetToSeed + ledger archive + clear drafts), `leash log [n]`, `leash verify`, `leash preflight`.

## Lane D: Viewer (`src/viewer/*`)

- `server.mjs`: `node:http` on 127.0.0.1, port `LEASH_VIEWER_PORT` default 4777. Routes: `GET /` (index.html), `GET /api/grants` (all grants with `active` and `msLeft`), `POST /api/grants/:id/revoke`, `GET /api/ledger?limit=200` (entries newest first + verify result), `GET /api/events` (Server-Sent Events: pushes when grants.json or ledger.jsonl changes; fall back to polling every second in the page).
- `index.html`: single file, no external requests except optional Google Fonts. Built for a projector: big type, high contrast, light and dark. Left: the three grant cards (name, app, verbs, records, fields, live countdown, Revoke). Right: the live ledger (newest on top, colored by decision: allowed, denied, approval, Touch ID, failed), and a chain badge ("Chain intact, 23 entries" or "Chain broken at 7"). New entries animate in.

## Lane E: Story (`docs/*`)

Devpost submission text, the updated 3-minute demo script for the P0 demo (VM moved to a roadmap slide), and the seed emails Kyle sends to the "Leash Demo" label, including the prompt-injection email.
