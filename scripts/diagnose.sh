#!/usr/bin/env bash
# Diagnose the transaction-builder-agent install. Prints the state of:
#   - Claude Desktop MCP config
#   - Claude CLI global MCP config
#   - MCP binary health (smoke test)
#   - Skill symlinks in ~/.claude/skills/
#   - Orphan MCP node processes
#
# Usage: ./scripts/diagnose.sh

set -uo pipefail  # no -e; we want to continue past errors

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"

echo "transaction-builder-agent diagnose"
echo "=========================="
echo "Project root: $PROJECT_ROOT"
echo ""

green() { printf "\033[32m%s\033[0m" "$1"; }
red()   { printf "\033[31m%s\033[0m" "$1"; }
yellow(){ printf "\033[33m%s\033[0m" "$1"; }

# ---- 1. Binary health ----
echo "── 1. MCP binary ────────────────────────────────────────────"
BIN="$PROJECT_ROOT/dist/index.js"
if [[ -f "$BIN" ]]; then
  echo "$(green ✓) Build exists at $BIN"
  if [[ -x "$BIN" ]]; then
    echo "$(green ✓) Has execute bit"
  else
    echo "$(yellow ⚠) Missing execute bit — run: chmod +x $BIN"
  fi
else
  echo "$(red ✗) Build MISSING — run: npm run build"
fi
echo ""

# ---- 2. Smoke test ----
echo "── 2. MCP stdio smoke test ──────────────────────────────────"
if [[ -f "$BIN" ]]; then
  ./scripts/smoke-mcp.sh || echo "$(red ✗) smoke-mcp failed — MCP server does not respond correctly"
else
  echo "(skipped, no binary)"
fi
echo ""

# ---- 3. Claude Desktop config ----
echo "── 3. Claude Desktop config ─────────────────────────────────"
case "$(uname)" in
  Darwin) DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  Linux)  DESKTOP_CFG="$HOME/.config/Claude/claude_desktop_config.json" ;;
  *)      DESKTOP_CFG="" ;;
esac
if [[ -z "$DESKTOP_CFG" ]]; then
  echo "$(yellow ⚠) Unknown OS — skipping Desktop config check."
elif [[ ! -f "$DESKTOP_CFG" ]]; then
  echo "$(yellow ⚠) Desktop config file does not exist: $DESKTOP_CFG"
  echo "   (That's fine if you don't use Claude Desktop.)"
else
  PATH_IN_CFG=$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const entry = cfg.mcpServers && cfg.mcpServers["transaction-builder"];
      if (!entry) { console.log("MISSING"); process.exit(0); }
      console.log((entry.args && entry.args[0]) || "MISSING");
    } catch { console.log("INVALID_JSON"); }
  ' "$DESKTOP_CFG")
  echo "Config : $DESKTOP_CFG"
  echo "Path   : $PATH_IN_CFG"
  if [[ "$PATH_IN_CFG" == "$BIN" ]]; then
    echo "$(green ✓) Points at current project build."
  elif [[ "$PATH_IN_CFG" == "MISSING" ]]; then
    echo "$(red ✗) transaction-builder not registered in Desktop config — run ./setup.sh"
  elif [[ "$PATH_IN_CFG" == "INVALID_JSON" ]]; then
    echo "$(red ✗) Desktop config is not valid JSON. Fix it manually or delete the transaction-builder entry."
  else
    echo "$(yellow ⚠) Desktop config points at a different path than this project."
    echo "   Run ./setup.sh from $PROJECT_ROOT to re-register."
  fi
fi
echo ""

# ---- 4. Claude Code project config ----
# Claude Code reads project-scoped MCP servers from `.mcp.json` at the repo root,
# pre-approved via `enabledMcpjsonServers` in the committed `.claude/settings.json`.
# Neither lives in ~/.claude.json — verify the committed files, then confirm the
# CLI actually connects via `claude mcp list`.
echo "── 4. Claude Code project config (.mcp.json) ────────────────"
MCP_JSON="$PROJECT_ROOT/.mcp.json"
SETTINGS_JSON="$PROJECT_ROOT/.claude/settings.json"

if [[ ! -f "$MCP_JSON" ]]; then
  echo "$(red ✗) $MCP_JSON missing — Claude Code has no project server to load."
else
  MCP_PATH=$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const e = cfg.mcpServers && cfg.mcpServers["transaction-builder"];
      console.log(e && e.args && e.args[0] ? e.args[0] : "MISSING");
    } catch { console.log("INVALID_JSON"); }
  ' "$MCP_JSON")
  echo "Config : $MCP_JSON"
  echo "Path   : $MCP_PATH"
  if [[ "$MCP_PATH" == *'${CLAUDE_PROJECT_DIR'*'}/dist/index.js' ]]; then
    echo "$(green ✓) Declares transaction-builder with a portable project-relative path."
  elif [[ "$MCP_PATH" == "MISSING" ]]; then
    echo "$(red ✗) transaction-builder not declared in .mcp.json."
  elif [[ "$MCP_PATH" == "INVALID_JSON" ]]; then
    echo "$(red ✗) .mcp.json is not valid JSON."
  else
    echo "$(yellow ⚠) Unexpected path in .mcp.json: $MCP_PATH"
  fi
fi

# Pre-approval check: the server must be listed in enabledMcpjsonServers or the
# session will park it at "Pending approval".
if [[ -f "$SETTINGS_JSON" ]]; then
  APPROVED=$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const list = Array.isArray(cfg.enabledMcpjsonServers) ? cfg.enabledMcpjsonServers : [];
      console.log(list.includes("transaction-builder") || cfg.enableAllProjectMcpServers === true ? "yes" : "no");
    } catch { console.log("no"); }
  ' "$SETTINGS_JSON")
  if [[ "$APPROVED" == "yes" ]]; then
    echo "$(green ✓) Pre-approved in .claude/settings.json (enabledMcpjsonServers)."
  else
    echo "$(yellow ⚠) Not pre-approved in .claude/settings.json — first session will prompt for approval."
  fi
fi

# Live connection check (authoritative). Resolve the path the same way a session
# does: from the project dir with CLAUDE_PROJECT_DIR set.
if command -v claude >/dev/null 2>&1; then
  LIVE="$(cd "$PROJECT_ROOT" && CLAUDE_PROJECT_DIR="$PROJECT_ROOT" claude mcp list 2>&1 | grep -E '^transaction-builder' || true)"
  if echo "$LIVE" | grep -q "Connected"; then
    echo "$(green ✓) claude mcp list: $LIVE"
  elif echo "$LIVE" | grep -q "Pending approval"; then
    echo "$(yellow ⚠) claude mcp list: $LIVE  (approve on first launch, or run ./setup.sh)"
  else
    echo "$(yellow ⚠) claude mcp list did not report Connected: ${LIVE:-<empty>}"
  fi
else
  echo "$(yellow ⚠) 'claude' CLI not on PATH — skipping live connection check."
fi

# Flag leftover stale registrations from earlier installer versions.
LEGACY_SETTINGS="$HOME/.claude/settings.json"
if [[ -f "$LEGACY_SETTINGS" ]]; then
  HAS_LEGACY=$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(cfg.mcpServers && cfg.mcpServers["transaction-builder"] ? "yes" : "no");
    } catch { console.log("no"); }
  ' "$LEGACY_SETTINGS")
  if [[ "$HAS_LEGACY" == "yes" ]]; then
    echo "$(yellow ⚠) Stale mcpServers entry in $LEGACY_SETTINGS — Claude Code ignores it. Re-run ./setup.sh to clean up."
  fi
fi
LEGACY_CLAUDE_JSON="$HOME/.claude.json"
if [[ -f "$LEGACY_CLAUDE_JSON" ]]; then
  HAS_CLI=$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const proj = cfg.projects && cfg.projects[process.argv[2]] && cfg.projects[process.argv[2]].mcpServers;
      console.log((cfg.mcpServers && cfg.mcpServers["transaction-builder"]) || (proj && proj["transaction-builder"]) ? "yes" : "no");
    } catch { console.log("no"); }
  ' "$LEGACY_CLAUDE_JSON" "$PROJECT_ROOT")
  if [[ "$HAS_CLI" == "yes" ]]; then
    echo "$(yellow ⚠) Stale user/local-scope entry in $LEGACY_CLAUDE_JSON duplicates the project .mcp.json. Re-run ./setup.sh to clean up."
  fi
fi
echo ""

# ---- 5. Skill symlinks ----
# Verify every skill install-config.sh links — iterate the project's skill dirs
# so this stays in sync as skills are added/removed (no hardcoded list).
echo "── 5. Skill symlinks ────────────────────────────────────────"
for skilldir in "$PROJECT_ROOT"/.claude/skills/*/; do
  [[ -d "$skilldir" ]] || continue
  skill="$(basename "$skilldir")"
  LINK="$HOME/.claude/skills/$skill"
  TARGET="${skilldir%/}"
  if [[ -L "$LINK" ]]; then
    ACTUAL=$(readlink "$LINK")
    if [[ "$ACTUAL" == "$TARGET" ]]; then
      echo "$(green ✓) $LINK → $ACTUAL"
    else
      echo "$(yellow ⚠) $LINK → $ACTUAL  (expected: $TARGET)"
    fi
  elif [[ -e "$LINK" ]]; then
    echo "$(yellow ⚠) $LINK exists but isn't a symlink (overrides project version)."
  else
    echo "$(red ✗) $LINK missing — run ./setup.sh"
  fi
done
echo ""

# ---- 6. Orphan node processes ----
echo "── 6. Orphan node processes ─────────────────────────────────"
PROCS=$(pgrep -fl "node.*transaction-builder-agent/dist/index" 2>/dev/null || true)
if [[ -z "$PROCS" ]]; then
  echo "$(green ✓) No running MCP processes (expected when Claude isn't open)."
else
  echo "Found running MCP processes:"
  echo "$PROCS"
  echo "If Claude still reports 'tools not loaded', these might be stale."
  echo "To clean them up: pkill -f 'node.*transaction-builder-agent/dist/index'"
fi
echo ""

echo "=========================="
echo "If something is $(red ✗) or $(yellow ⚠), fix it as noted and re-run this script."
echo "If all $(green ✓) but Claude still can't see the tools, fully quit and relaunch Claude"
echo "(⌘Q on Mac, not close-window). The MCP handshake only runs on app start."
