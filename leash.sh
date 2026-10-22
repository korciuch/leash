#!/usr/bin/env bash
# Leash on this Mac: one idempotent entry point.
#   ./leash.sh            install or update ~/leash and point Claude Desktop at it (LEASH_PHONE=you@icloud.com ./leash.sh adds iPhone approvals)
#   ./leash.sh reset      before each rehearsal: refresh demo calendars and Errands, fresh grants, new ledger, no drafts
#   ./leash.sh viewer     start the grants and ledger page and open it
#   ./leash.sh status     show grants, the last ledger rows and the chain check
#   ./leash.sh http       serve Leash over HTTP for Claude Code in a VM; prints the command to paste in the VM
# Written for the bash 3.2 that ships with macOS.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/leash"
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
PORT="${LEASH_VIEWER_PORT:-4777}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
fail() { printf '  \033[31m%s\033[0m\n' "$*"; exit 1; }

need_node() {
  command -v node >/dev/null 2>&1 || fail "Node not found. Install it with: brew install node"
}

install() {
  bold "Install Leash to $APP_DIR"
  need_node
  [[ "$(uname -s)" == "Darwin" ]] || fail "Run this on your Mac."
  mkdir -p "$APP_DIR"
  rsync -a --exclude node_modules --exclude helper/Leash --exclude .DS_Store --exclude 'docs/*.png' "$SRC_DIR/" "$APP_DIR/"
  info "Files synced"
  if [[ ! -d "$APP_DIR/node_modules/@modelcontextprotocol" || "$APP_DIR/package.json" -nt "$APP_DIR/node_modules" ]]; then
    info "Installing dependencies..."
    (cd "$APP_DIR" && npm install --silent --no-audit --no-fund)
    touch "$APP_DIR/node_modules"
  fi
  if [[ ! -x "$APP_DIR/helper/Leash" || "$APP_DIR/helper/Leash.swift" -nt "$APP_DIR/helper/Leash" ]]; then
    command -v swiftc >/dev/null 2>&1 || fail "swiftc not found; install Xcode first."
    info "Building the Touch ID helper..."
    swiftc "$APP_DIR/helper/Leash.swift" -o "$APP_DIR/helper/Leash"
  fi
  chmod +x "$APP_DIR/src/cli.mjs" "$APP_DIR/leash.sh"
  local state
  state="$(configure_claude)" || fail "Claude Desktop config is not valid JSON: $state"
  info "Claude Desktop config: $state"
  local url
  url="$(public_url)"
  if [[ -n "$url" ]]; then
    info "Phone approval links: $url (Tailscale or LEASH_PUBLIC_URL)"
  else
    info "Phone approval links: this Mac's Wi-Fi or Ethernet address (phone must be on the same network)"
  fi
  if [[ "$state" != "unchanged" ]]; then
    warn "Quit Claude Desktop with Cmd-Q and reopen it so it loads Leash."
  fi
  bold "Done. Next: ./leash.sh reset, then ./leash.sh viewer"
}

tailscale_ip() {
  local cli
  for cli in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    if command -v "$cli" >/dev/null 2>&1 || [[ -x "$cli" ]]; then
      "$cli" ip -4 2>/dev/null | sed -n 1p
      return 0
    fi
  done
  return 0
}

public_url() {
  if [[ -n "${LEASH_PUBLIC_URL:-}" ]]; then
    printf '%s' "$LEASH_PUBLIC_URL"
    return 0
  fi
  local ip
  ip="$(tailscale_ip)"
  if [[ -n "$ip" ]]; then
    printf 'http://%s:%s' "$ip" "$PORT"
  fi
}

configure_claude() {
  mkdir -p "$(dirname "$CLAUDE_CONFIG")"
  node - "$CLAUDE_CONFIG" "$(command -v node)" "$APP_DIR/src/server.mjs" "$APP_DIR/helper/Leash" "${LEASH_PHONE:-}" "$(public_url)" <<'JS'
const fs = require('fs');
const [file, command, server, helper, phone, publicUrl] = process.argv.slice(2);
let config = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  try { config = raw ? JSON.parse(raw) : {}; } catch (error) { console.log(error.message); process.exit(1); }
}
const env = { LEASH_TOUCHID: helper };
if (phone) { env.LEASH_PHONE = phone; env.LEASH_PHONE_FIRST_SEC = '20'; }
if (publicUrl) env.LEASH_PUBLIC_URL = publicUrl;
const wanted = { command, args: [server], env };
config.mcpServers = config.mcpServers || {};
const hadSpike = Boolean(config.mcpServers['leash-spike']);
if (!hadSpike && JSON.stringify(config.mcpServers.leash || null) === JSON.stringify(wanted)) {
  console.log('unchanged');
  process.exit(0);
}
const backup = file + '.before-leash';
if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
delete config.mcpServers['leash-spike'];
config.mcpServers.leash = wanted;
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(hadSpike ? 'updated (replaced leash-spike with leash)' : 'updated');
JS
}

reset() {
  bold "Reset the demo"
  need_node
  [[ -d "$APP_DIR" ]] || fail "Run ./leash.sh first."
  osascript -l JavaScript "$APP_DIR/scripts/seed-demo.js" "${LEASH_CALENDAR:-Leash Demo}" "Leash Personal" "${LEASH_ERRANDS:-Errands}" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const r = JSON.parse(s);
  console.log("  Demo data: " + r.summary + ", events on the week of " + r.monday);
  for (const x of r.results) if (x.action !== "unchanged" && x.action !== "exists") console.log("    " + x.action + ": " + x.name);
});'
  node "$APP_DIR/src/cli.mjs" reset
  info "Remove any Errands items the agent added in earlier rehearsals by hand in Reminders."
}

viewer() {
  need_node
  [[ -d "$APP_DIR" ]] || fail "Run ./leash.sh first."
  bold "Viewer on http://127.0.0.1:$PORT (Ctrl-C to stop); phone approval links use this Mac's Wi-Fi address"
  (sleep 1 && open "http://127.0.0.1:$PORT") &
  LEASH_VIEWER_HOST="${LEASH_VIEWER_HOST:-0.0.0.0}" LEASH_VIEWER_PORT="$PORT" node "$APP_DIR/src/viewer/server.mjs"
}

status() {
  need_node
  node "$APP_DIR/src/cli.mjs" grants
  node "$APP_DIR/src/cli.mjs" log 10
  node "$APP_DIR/src/cli.mjs" verify
}

http_server() {
  need_node
  [[ -d "$APP_DIR" ]] || fail "Run ./leash.sh first."
  local token_file="$HOME/.leash/http-token" token addr http_port
  http_port="${LEASH_HTTP_PORT:-4778}"
  mkdir -p "$HOME/.leash"
  if [[ ! -s "$token_file" ]]; then
    (umask 077 && node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' > "$token_file")
  fi
  chmod 600 "$token_file"
  token="$(cat "$token_file")"
  addr="$(ipconfig getifaddr bridge100 2>/dev/null || true)"
  [[ -n "$addr" ]] || addr="192.168.64.1"
  bold "Leash over HTTP on port $http_port (Ctrl-C to stop)"
  info "VM bridge address: $addr"
  info "Paste this inside the VM:"
  printf '\n    claude mcp add --transport http leash http://%s:%s/mcp --header "Authorization: Bearer %s"\n\n' "$addr" "$http_port" "$token"
  LEASH_HTTP_TOKEN="$token" LEASH_HTTP_PORT="$http_port" LEASH_PHONE="${LEASH_PHONE:-}" LEASH_TOUCHID="$APP_DIR/helper/Leash" node "$APP_DIR/src/http.mjs"
}

case "${1:-install}" in
  install) install ;;
  reset) reset ;;
  viewer) viewer ;;
  status) status ;;
  http) http_server ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
