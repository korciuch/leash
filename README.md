# Leash

Scoped, expiring, logged consent for AI agents on your Mac.

macOS asks once whether a process may control Calendar or Mail, and after that the answer covers everything. For an MCP server the prompt names `node`, so one Allow lets every Node program on the Mac read your calendar and send mail as you. Leash sits between the agent and your apps and sets the terms:

- **Grants** scoped by app, verbs, records (named calendars, mailboxes, lists), fields and time. They expire on their own.
- **Result filtering:** the model only ever sees granted records and fields. Event notes, ungranted calendars and old mail are withheld.
- **Approval dialog** for anything outside a grant: Deny (default), Allow once, Allow for 1 hour.
- **Touch ID** for every send, even inside a grant.
- **Hash-chained ledger** of every call, with a live viewer showing grants, countdowns and a Revoke button.

## Run it

```
./leash.sh
./leash.sh reset
./leash.sh viewer
```

`./leash.sh` installs to `~/leash`, builds the Touch ID helper and registers Leash with Claude Desktop (quit and reopen Claude Desktop after). `reset` refreshes the demo calendars, Errands list, grants and ledger. `viewer` serves the grants and ledger page on http://127.0.0.1:4777.

Requires macOS 27, Xcode (for `swiftc`) and Node 20 or later.

## Layout

| Path | What |
| --- | --- |
| `src/gate/` | Grants, policy, result filters, ledger |
| `src/apple/` | Fixed JXA scripts for Calendar, Reminders, Mail and Messages |
| `src/consent/` | Native approval dialog and Touch ID |
| `src/server.mjs`, `src/tools.mjs` | The MCP server and its tools |
| `src/viewer/` | Grants and ledger viewer |
| `helper/Leash.swift` | Touch ID helper (LocalAuthentication) |
| `docs/` | Demo script, Devpost text, seed emails, validation spikes |

Tests: `npm test` (runs on any OS with fakes for osascript and Touch ID).

Built at the super{set} hackathon, Track 2: personal agents and data privacy.
