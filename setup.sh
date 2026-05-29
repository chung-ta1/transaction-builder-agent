#!/usr/bin/env bash
# One-shot setup for transaction-builder-agent. Run from the project root.
# Builds the MCP, bootstraps runtime memory, and registers it with Claude.
# Safe to re-run — idempotent.

set -euo pipefail

cd "$(dirname "$0")"

echo "transaction-builder-agent setup"
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
STALE=$(pgrep -fl "node.*transaction-builder-agent/dist/index" 2>/dev/null || true)
if [[ -n "$STALE" ]]; then
  STALE_COUNT=$(echo "$STALE" | wc -l | tr -d ' ')
  pkill -f "node.*transaction-builder-agent/dist/index" 2>/dev/null || true
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

# ---- 7. Restart reminder ----
# MCPs load once, at session start. Any Claude session already running when
# setup finishes won't see the new tools until it restarts.
if [[ -n "${CLAUDECODE:-}" ]]; then
  echo "⚠ You ran this from inside Claude Code. Type /exit and run 'claude' again to load the tools."
  echo ""
fi

cat <<'EOF'
============================================================
✓ Setup complete. Restart Claude (⌘Q Desktop, or /exit then 'claude' in CLI).

Then describe a deal in plain English, e.g.:
  "Create a transaction: $20k commission sale, me and my partner
   Tamir split 60/40, 123 Main St NYC 10025."

Your first draft opens a browser to sign in to Real.

If tools still aren't loaded after restarting, run ./scripts/diagnose.sh.
============================================================
EOF
