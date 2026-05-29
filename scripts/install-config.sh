#!/usr/bin/env bash
# Wires transaction-builder-agent into Claude — Desktop (via claude_desktop_config.json)
# AND Claude CLI / Claude Code (via ~/.claude/settings.json + symlinks to
# ~/.claude/skills). Creates config files if missing, merges cleanly if they
# exist. Idempotent — safe to re-run.
#
# We intentionally do NOT symlink any subagent file. Subagents in Claude Code
# inherit only pre-materialized MCP tools from the parent session, which means
# our MCP tools often aren't visible in subagent context. Running the runbook
# inline in the skill (main-chat) avoids this.
#
# Usage: ./scripts/install-config.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_PATH="$PROJECT_ROOT/dist/index.js"

if [[ ! -f "$BIN_PATH" ]]; then
  echo "✗ Build output not found at $BIN_PATH"
  echo "  Run 'npm install && npm run build' first, then re-run this script."
  exit 1
fi

case "$(uname)" in
  Darwin)
    DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
    DESKTOP_DIR="$HOME/Library/Application Support/Claude"
    ;;
  Linux)
    DESKTOP_CONFIG="$HOME/.config/Claude/claude_desktop_config.json"
    DESKTOP_DIR="$HOME/.config/Claude"
    ;;
  *)
    echo "✗ Unsupported OS: $(uname)." >&2
    exit 1
    ;;
esac

CLI_CONFIG="$HOME/.claude/settings.json"
CLI_SKILLS="$HOME/.claude/skills"
CLI_AGENTS="$HOME/.claude/agents"

# ---------- 1. Register MCP in Claude Desktop config ----------
mkdir -p "$DESKTOP_DIR"
[[ -s "$DESKTOP_CONFIG" ]] || echo "{}" > "$DESKTOP_CONFIG"

merge_mcp_into_config() {
  local path="$1"
  local bin="$2"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const bin = process.argv[2];
    const raw = fs.readFileSync(path, "utf8").trim() || "{}";
    let cfg;
    try { cfg = JSON.parse(raw); }
    catch (e) { console.error("✗ Existing config is not valid JSON: " + path); process.exit(1); }
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers["transaction-builder"] = { command: "node", args: [bin] };
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  ' "$path" "$bin"
}

merge_mcp_into_config "$DESKTOP_CONFIG" "$BIN_PATH"
echo "✓ Claude Desktop MCP registered."
echo "  $DESKTOP_CONFIG"

# ---------- 2. Claude Code (CLI / IDE) — uses the committed project config ----------
# Claude Code reads project-scoped MCP servers from `.mcp.json` at the repo root
# (NOT from `.claude/settings.json`, which only carries settings like
# `enabledMcpjsonServers`). Both files are committed, so a freshly-cloned repo is
# self-contained — no per-user registration needed:
#   • .mcp.json            declares the server with a `${CLAUDE_PROJECT_DIR:-.}/dist/index.js` path
#   • .claude/settings.json pre-approves it via `enabledMcpjsonServers` (skips the trust prompt)
# We only VERIFY the handshake here and clean up obsolete per-user registrations
# from earlier installer versions.
#
# Locating the CLI is not as simple as `command -v claude`: the Claude Code
# *local installer* drops the binary at ~/.claude/local/claude and exposes it
# ONLY as a shell alias in the user's rc file. Non-interactive scripts like this
# one don't load aliases, so `command -v claude` returns nothing even though the
# CLI is installed — and the verify/cleanup step below gets silently skipped.
# Resolve the real binary path across all known install layouts before giving up.
resolve_claude_bin() {
  # 1. On PATH (npm global, Homebrew, official installer symlink).
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi
  # 2. Local installer location (alias-only; not on a script's PATH).
  if [[ -x "$HOME/.claude/local/claude" ]]; then
    echo "$HOME/.claude/local/claude"
    return 0
  fi
  # 3. Honor an explicit override if the user knows where it is.
  if [[ -n "${CLAUDE_CLI:-}" && -x "${CLAUDE_CLI}" ]]; then
    echo "$CLAUDE_CLI"
    return 0
  fi
  return 1
}

if CLAUDE_BIN="$(resolve_claude_bin)"; then
  # Earlier versions registered a user/local-scope CLI entry via `claude mcp add`.
  # That now duplicates the committed project `.mcp.json` (and can shadow it),
  # so remove it — the project config is the single source of truth.
  "$CLAUDE_BIN" mcp remove transaction-builder --scope user  >/dev/null 2>&1 || true
  "$CLAUDE_BIN" mcp remove transaction-builder --scope local >/dev/null 2>&1 || true

  # Verify Claude Code can actually connect to the project server. Run from the
  # project dir with CLAUDE_PROJECT_DIR set so `${CLAUDE_PROJECT_DIR:-.}` resolves.
  MCP_STATUS="$(cd "$PROJECT_ROOT" && CLAUDE_PROJECT_DIR="$PROJECT_ROOT" "$CLAUDE_BIN" mcp list 2>&1 | grep -E '^transaction-builder' || true)"
  if echo "$MCP_STATUS" | grep -q "Connected"; then
    echo "✓ Claude Code MCP connected (project .mcp.json)."
    echo "  ↳ $MCP_STATUS"
  elif echo "$MCP_STATUS" | grep -q "Pending approval"; then
    echo "✓ Claude Code MCP registered (project .mcp.json)."
    echo "  ↳ $MCP_STATUS — it auto-approves via .claude/settings.json on next launch."
  else
    echo "  ! Claude Code did not report transaction-builder as connected. Output was:"
    echo "    ${MCP_STATUS:-<empty>}"
    echo "    From $PROJECT_ROOT run: claude mcp list   (expect: ✓ Connected)"
  fi
else
  echo "  ! Could not locate the 'claude' CLI (not on PATH, not at"
  echo "    ~/.claude/local/claude, and \$CLAUDE_CLI is unset) — skipping Claude Code check."
  echo "    Claude Desktop is already registered above. To use Claude Code, install it"
  echo "    from https://docs.claude.com/en/docs/claude-code/overview"
  echo "    (or set CLAUDE_CLI=/path/to/claude) and re-run ./setup.sh."
fi

# Cleanup: earlier installer versions wrote `mcpServers.transaction-builder`
# into ~/.claude/settings.json. Claude Code ignores that file for MCP discovery —
# remove the stale entry so future debug sessions aren't misled.
if [[ -s "$CLI_CONFIG" ]]; then
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch { process.exit(0); }
    if (cfg.mcpServers && cfg.mcpServers["transaction-builder"]) {
      delete cfg.mcpServers["transaction-builder"];
      if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
      console.log("  ↳ Removed stale mcpServers.transaction-builder from ~/.claude/settings.json");
    }
  ' "$CLI_CONFIG"
fi

# ---------- 3. Symlink skills into Claude CLI global dir ----------
# Skills only. No subagent — see header for why.
mkdir -p "$CLI_SKILLS"

link() {
  local target="$1"
  local linkpath="$2"
  if [[ -L "$linkpath" ]]; then
    rm -f "$linkpath"
  elif [[ -e "$linkpath" ]]; then
    local backup="$linkpath.bak.$(date +%s)"
    echo "  ! $linkpath exists and isn't a symlink — backing up to $backup"
    mv "$linkpath" "$backup"
  fi
  ln -s "$target" "$linkpath"
  echo "  ↳ $linkpath → $target"
}

echo "✓ Claude CLI skill symlinks:"
# Link every generated skill so all are available as CLI slash-commands.
for skilldir in "$PROJECT_ROOT"/.claude/skills/*/; do
  skillname="$(basename "$skilldir")"
  link "${skilldir%/}" "$CLI_SKILLS/$skillname"
done

# Remove any legacy agent symlink from a previous install.
if [[ -L "$CLI_AGENTS/transaction-creator.md" ]]; then
  rm -f "$CLI_AGENTS/transaction-creator.md"
  echo "  ✗ Removed legacy ~/.claude/agents/transaction-creator.md symlink (subagents don't work with our MCP pattern)."
fi

echo ""
echo "→ Restart Claude Desktop (⌘Q + relaunch) or Claude CLI to pick up the change."
