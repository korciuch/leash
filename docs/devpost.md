# Leash

**Tagline:** Scoped, expiring, logged consent for AI agents on your Mac

## Inspiration

We connected Claude Desktop to Calendar through an MCP server and macOS asked whether "node" could control Calendar. Not Claude. One Allow lets every Node program on the Mac control Calendar, and it survives relaunches. In early October 2026, after a columnist reported that Meta's Muse agent read his Messages, Apple said it would tighten Full Disk Access (Techzine). Existing tools don't help: applescript-mcp runs any script it is handed, and Apple Productivity MCP covers 17 apps with on/off switches, no per-action approval and no log. We wanted consent shaped like the task: this calendar, these fields, for one hour.

## What it does

Leash is a local MCP server between the agent and Calendar, Reminders, Mail and Messages. Every call is checked against a grant naming an app, verbs, records, fields and an expiry.

- **Grants:** "Plan the week" (Leash Demo calendar, titles and times, 1 hour), "Draft replies" (one mailbox, read, draft and send, 1 hour), "Errands list" (read and create, this session).
- **Filtering:** the model gets only granted records and fields. Event notes holding a door code and a PIN are withheld; a confidential interview on a personal calendar is never read.
- **The agent has to say why:** every call carries the agent's reason in its own words. Leash shows it in the approval dialog and logs it, so a prompt-injected request reads as what it is: "a newsletter told me to text everyone this link."
- **Native approval:** anything outside a grant opens a Leash dialog on top of Claude Desktop. It defaults to Deny and returns the choice to the agent.
- **Touch ID per send:** every email send needs a fingerprint, even inside a grant.
- **Ledger:** every call, allowed or denied, lands in a SHA-256 hash-chained log.
- **Live viewer:** grant countdowns, a Revoke button, the ledger with each agent's reason, withheld fields shown as redaction bars, a chain badge, and a full-screen red "Blocked" banner the moment Leash stops something.

## How we built it

Node.js ESM with the MCP SDK and zod, no build step. Apple access goes through fixed JXA scripts run by osascript with one JSON argument, so no script is built from agent input. A policy module decides allow, ask, Touch ID or deny and pushes the grant's limits into the script inputs. Touch ID is a small Swift helper using LocalAuthentication. The viewer is node:http with Server-Sent Events.

## Challenges we ran into

- macOS attributes Automation to "node", so its prompt can't say who is asking. Leash's own prompts can.
- Large synced calendars cost 1 to 6 s each; the seeded calendars read in 45 to 97 ms and Mail in 97 ms. Leash queries only what a grant names: faster, and less leaks.
- Keeping the dialog in front of Claude Desktop, defaulting to Deny and timing out to Deny.
- Two Leash processes started at once and broke the hash chain on their first writes. Appends now take a lock file; 200 writes racing from 4 processes verify intact.
- iMessage won't notify you about a text from your own Apple Account, so approvals on your phone need a second account to send from. Signing a new Apple Account into the VM stalled, so phone approvals stayed on the roadmap.

## Accomplishments that we're proud of

- A prompt-injection email tells the agent to text everyone a link. The send hits the Leash dialog, we press Deny, and a red row lands in the ledger.
- Touch ID works with Claude as the caller, and the prompt names Leash (3.4 s).
- Revoking in the viewer takes effect on the next call.
- A macOS 27 virtual machine built from Apple's Virtualization framework sample, booted on a 16 GB MacBook Air, as the future home of the agent.

## What we learned

Consent needs a scope, an expiry and a record. Per-app switches are too coarse, and a prompt that names the wrong program trains people to click Allow.

## What's next

- **The agent's own Mac:** the VM already boots. Next, Claude Code inside it reaches Leash over a token-protected HTTP endpoint (built), with its own Apple Account seeing only the calendars and lists you share through iCloud. Its home folder has none of your files or keys.
- **Approvals on your iPhone:** Leash texts the request, the agent's reason and a code; you reply "no 4821" or tap a link. The code is built; it needs the agent's Apple Account to send from.
- **A signed Leash app** so the macOS prompt names Leash instead of node, and an EventKit index for large synced calendars.

## Built with

Node.js, Model Context Protocol SDK, zod, JavaScript for Automation, Swift, LocalAuthentication, Claude Desktop, macOS.
