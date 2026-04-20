#!/usr/bin/env bash
# One-shot setup for transaction-agent. Run from the project root.
#
# Does everything:
#   1. Verifies Node.js is installed
#   2. Installs npm dependencies
#   3. Builds the MCP server (and regenerates CLI skill wrappers from source)
#   3b. Bootstraps runtime memory files from .template versions (first-run)
#   4. Smoke-tests the built MCP (confirms tools load via stdio)
#   5. Kills any stale MCP processes so Claude reconnects to the fresh binary
#   6. Registers with Claude Desktop AND Claude CLI / Claude Code globally
#
# Safe to re-run. Idempotent.

set -euo pipefail

cd "$(dirname "$0")"

echo "transaction-agent setup"
echo "======================="
echo ""

# ---- 1. Check Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is not installed."
  echo "  Install the LTS version from https://nodejs.org, then re-run ./setup.sh"
  exit 1
fi

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*$/\1/')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "✗ Node.js $NODE_MAJOR is too old (need 18+)."
  echo "  Upgrade from https://nodejs.org, then re-run ./setup.sh"
  exit 1
fi

echo "✓ Node.js $(node -v)"
echo ""

# ---- 2. Install npm dependencies ----
echo "→ Installing dependencies (npm install)…"
npm install --silent
echo "✓ Dependencies installed."
echo ""

# ---- 3. Build ----
echo "→ Building (npm run build)…"
npm run build --silent
echo "✓ Build complete."
echo ""

# ---- 3b. Bootstrap runtime memory from templates ----
# These files contain per-user data (yentaIds, emails, draft history, cached
# agent resolutions) that the agent writes to at runtime. They're gitignored
# and must be copied from the .template versions on first install. Safe to
# re-run — never overwrites an existing file.
echo "→ Bootstrapping runtime memory from templates (if missing)…"
MEMORY_BOOTSTRAP_COUNT=0
for tpl in memory/*.md.template; do
  [[ -f "$tpl" ]] || continue
  target="${tpl%.template}"
  if [[ ! -f "$target" ]]; then
    cp "$tpl" "$target"
    echo "  + Created $target from template"
    MEMORY_BOOTSTRAP_COUNT=$((MEMORY_BOOTSTRAP_COUNT + 1))
  fi
done
if [[ $MEMORY_BOOTSTRAP_COUNT -eq 0 ]]; then
  echo "✓ All runtime memory files already present; no templates copied."
else
  echo "✓ Bootstrapped $MEMORY_BOOTSTRAP_COUNT runtime memory file(s) from templates."
fi
echo ""

# ---- 4. Smoke-test the MCP ----
echo "→ Smoke-testing the MCP server…"
./scripts/smoke-mcp.sh
echo ""

# ---- 5. Kill stale MCP processes ----
echo "→ Cleaning up any stale MCP processes from a previous install…"
STALE=$(pgrep -fl "node.*transaction-agent/dist/index" 2>/dev/null || true)
if [[ -n "$STALE" ]]; then
  STALE_COUNT=$(echo "$STALE" | wc -l | tr -d ' ')
  pkill -f "node.*transaction-agent/dist/index" 2>/dev/null || true
  sleep 0.5
  echo "✓ Killed $STALE_COUNT stale MCP process(es). Claude will start a fresh one on next launch."
else
  echo "✓ No stale MCP processes."
fi
echo ""

# ---- 6. Register with Claude Desktop + Claude CLI ----
echo "→ Registering with Claude Desktop + Claude CLI…"
./scripts/install-config.sh
echo ""

# ---- 7. Detect running Claude sessions that must be restarted ----
# The MCP handshake happens once, at session start. Any Claude Code or
# Claude Desktop session that was already running when setup.sh finished
# will NOT see the newly-registered tools — no matter what `claude mcp list`
# says. We detect that case and print a loud, unmissable banner.
#
# Two cases we care about:
#   (A) setup.sh was invoked FROM INSIDE a Claude Code session ($CLAUDECODE
#       is set by the CLI). That session is guaranteed stale.
#   (B) Some OTHER Claude process is running in another terminal / the
#       Desktop app — it's also stale, but we can't be sure which.

RUNNING_CLI="$(pgrep -fl '/claude($| )' 2>/dev/null | grep -vE 'setup\.sh|install-config' || true)"
RUNNING_DESKTOP="$(pgrep -fl 'Claude.app/Contents/MacOS/Claude' 2>/dev/null || true)"

NEED_RESTART=0
BANNER=""
if [[ -n "${CLAUDECODE:-}" ]]; then
  NEED_RESTART=1
  BANNER+="  • You ran setup.sh from INSIDE a Claude Code session.\n"
  BANNER+="    That session's tool list was frozen when it started — it\n"
  BANNER+="    will NOT see transaction-builder tools until you restart.\n"
  BANNER+="    In this terminal: type  /exit   then run  claude  again.\n"
fi
if [[ -n "$RUNNING_CLI" ]]; then
  NEED_RESTART=1
  BANNER+="  • A 'claude' CLI process is running:\n"
  while IFS= read -r line; do BANNER+="      $line\n"; done <<<"$RUNNING_CLI"
  BANNER+="    Exit each one (/exit) and relaunch to pick up the new MCP.\n"
fi
if [[ -n "$RUNNING_DESKTOP" ]]; then
  NEED_RESTART=1
  BANNER+="  • Claude Desktop is running. ⌘Q (fully quit — not just close\n"
  BANNER+="    the window) and relaunch it.\n"
fi

if [[ "$NEED_RESTART" -eq 1 ]]; then
  cat <<EOF

╔════════════════════════════════════════════════════════════════╗
║  ⚠  RESTART REQUIRED — setup is done, but live sessions are    ║
║     stale. MCPs load once, at session start. Until you         ║
║     restart, Claude will still report "tools aren't loaded".   ║
╠════════════════════════════════════════════════════════════════╣
EOF
  printf '%b' "$BANNER" | sed 's/^/║ /; s/$/ /'
  cat <<'EOF'
╚════════════════════════════════════════════════════════════════╝

EOF
fi

cat <<'EOF'
============================================================
✓ Setup complete.

If you saw the ⚠ RESTART REQUIRED banner above, do that first.
Otherwise:

  1) Launch Claude Desktop or run 'claude' in a fresh terminal.
  2) In a chat, describe your deal in plain English:

         "Create a transaction: $20k commission sale, me and my partner
          Tamir split 60/40, 123 Main St NYC 10025."

Your first draft will open a browser window to sign in to Real — your
password manager should auto-fill. After that you're signed in for the
session.

Troubleshooting:
  • ./scripts/diagnose.sh        Show current state: config paths,
                                 smoke-test, symlinks, orphan procs.
  • ./scripts/smoke-mcp.sh       Verify the MCP binary alone is healthy.
  • If Claude says "tools aren't loaded in this session" AFTER you've
    restarted: run ./scripts/diagnose.sh and report its output.
============================================================
EOF
