#!/usr/bin/env bash
# Diagnose the transaction-builder-agent install. Prints the state of:
#   - Claude Desktop MCP config
#   - Claude CLI global MCP config
#   - MCP binary health (smoke test)
#   - Skill symlinks in ~/.claude/skills/
#   - Any lingering subagent references
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

# ---- 4. Claude Code CLI config ----
# Claude Code CLI stores MCP entries in ~/.claude.json (managed via
# `claude mcp add`), NOT ~/.claude/settings.json. Resolve the path the same
# way the CLI does: project-local section first, then user-scope top-level.
echo "── 4. Claude Code CLI config ────────────────────────────────"
CLI_CFG="$HOME/.claude.json"
if [[ ! -f "$CLI_CFG" ]]; then
  echo "$(yellow ⚠) $CLI_CFG does not exist (Claude Code CLI may not be installed)."
else
  CLI_INFO=$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const projectKey = process.argv[2];
      const local = cfg.projects && cfg.projects[projectKey] && cfg.projects[projectKey].mcpServers && cfg.projects[projectKey].mcpServers["transaction-builder"];
      const user  = cfg.mcpServers && cfg.mcpServers["transaction-builder"];
      const entry = local || user;
      const scope = local ? "local (project)" : (user ? "user (global)" : "MISSING");
      if (!entry) { console.log("MISSING\t-"); process.exit(0); }
      console.log(((entry.args && entry.args[0]) || "MISSING") + "\t" + scope);
    } catch { console.log("INVALID_JSON\t-"); }
  ' "$CLI_CFG" "$PROJECT_ROOT")
  CLI_PATH="${CLI_INFO%	*}"
  CLI_SCOPE="${CLI_INFO#*	}"
  echo "Config : $CLI_CFG"
  echo "Path   : $CLI_PATH"
  echo "Scope  : $CLI_SCOPE"
  if [[ "$CLI_PATH" == "$BIN" ]]; then
    echo "$(green ✓) Points at current project build."
    if [[ "$CLI_SCOPE" == "local (project)" ]]; then
      echo "   Note: registered project-local — only works from $PROJECT_ROOT."
      echo "   Re-run ./setup.sh to upgrade to user scope (works from any directory)."
    fi
  elif [[ "$CLI_PATH" == "MISSING" ]]; then
    echo "$(red ✗) transaction-builder not registered for Claude Code CLI — run ./setup.sh"
  else
    echo "$(yellow ⚠) CLI config points at a different path."
    echo "   Run ./setup.sh from $PROJECT_ROOT to re-register."
  fi
fi

# Also flag any leftover stale entry in the OLD location.
LEGACY_CFG="$HOME/.claude/settings.json"
if [[ -f "$LEGACY_CFG" ]]; then
  HAS_LEGACY=$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(cfg.mcpServers && cfg.mcpServers["transaction-builder"] ? "yes" : "no");
    } catch { console.log("no"); }
  ' "$LEGACY_CFG")
  if [[ "$HAS_LEGACY" == "yes" ]]; then
    echo "$(yellow ⚠) Stale entry in $LEGACY_CFG — Claude Code CLI ignores it for MCP discovery."
    echo "   Re-run ./setup.sh to clean it up automatically."
  fi
fi
echo ""

# ---- 5. Skill symlinks ----
echo "── 5. Skill symlinks ────────────────────────────────────────"
for skill in create-transaction sync-rules; do
  LINK="$HOME/.claude/skills/$skill"
  TARGET="$PROJECT_ROOT/.claude/skills/$skill"
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

# ---- 6. Legacy subagent check ----
echo "── 6. Legacy subagent cleanup ───────────────────────────────"
LEGACY_AGENT="$HOME/.claude/agents/transaction-creator.md"
if [[ -L "$LEGACY_AGENT" || -f "$LEGACY_AGENT" ]]; then
  echo "$(yellow ⚠) Legacy subagent file still present: $LEGACY_AGENT"
  echo "   Claude Code subagents don't reliably see our MCP tools. Remove it:"
  echo "     rm $LEGACY_AGENT"
else
  echo "$(green ✓) No legacy subagent file."
fi
if [[ -f "$PROJECT_ROOT/.claude/agents/transaction-creator.md" ]]; then
  echo "$(yellow ⚠) Legacy subagent file still in project: $PROJECT_ROOT/.claude/agents/transaction-creator.md"
  echo "   Remove it: rm '$PROJECT_ROOT/.claude/agents/transaction-creator.md'"
  echo "   (or re-run 'npm run build' — the generator cleans it up.)"
fi
echo ""

# ---- 7. Orphan node processes ----
echo "── 7. Orphan node processes ─────────────────────────────────"
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
