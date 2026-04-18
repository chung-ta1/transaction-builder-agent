#!/usr/bin/env bash
# Wires transaction-agent into Claude — Desktop (via claude_desktop_config.json)
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

# ---------- 2. Register MCP for Claude Code CLI ----------
# Claude Code CLI reads MCP entries from ~/.claude.json (managed via
# `claude mcp add`), NOT ~/.claude/settings.json. Earlier installer versions
# wrote settings.json — that registration was silently ignored by the CLI.
if command -v claude >/dev/null 2>&1; then
  # Idempotent: drop any stale entry (user OR local scope), then re-add at user scope.
  claude mcp remove transaction-builder --scope user  >/dev/null 2>&1 || true
  claude mcp remove transaction-builder --scope local >/dev/null 2>&1 || true
  claude mcp add --scope user transaction-builder node "$BIN_PATH" >/dev/null
  echo "✓ Claude Code CLI MCP registered (user scope)."
  echo "  ~/.claude.json"

  # Verify the CLI actually connects to the server (registration alone doesn't
  # prove the binary spawns + advertises tools). Without this, users hit
  # "tools aren't loaded" at runtime and blame the installer.
  MCP_STATUS="$(claude mcp list 2>&1 | grep -E '^transaction-builder' || true)"
  if [[ -z "$MCP_STATUS" ]]; then
    echo "  ! 'claude mcp list' did not list transaction-builder after registration."
    echo "    Try: claude mcp list   (should show: transaction-builder ... ✓ Connected)"
  elif echo "$MCP_STATUS" | grep -q "Connected"; then
    echo "  ↳ claude mcp list: $MCP_STATUS"
  else
    echo "  ! 'claude mcp list' did not report ✓ Connected. Output was:"
    echo "    $MCP_STATUS"
    echo "    Re-run: node $BIN_PATH   (the server should sit silently on stdio)."
  fi
else
  echo "  ! 'claude' CLI not found on PATH — skipping CLI registration."
  echo "    Claude Desktop is already registered above. If you also use the CLI,"
  echo "    install it from https://docs.claude.com/en/docs/claude-code/overview"
  echo "    and re-run ./setup.sh."
fi

# Cleanup: earlier installer versions wrote `mcpServers.transaction-builder`
# into ~/.claude/settings.json. The CLI ignores that file for MCP discovery —
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

# The repo also ships a project-scope `.claude/settings.json` that declares
# transaction-builder under mcpServers. Claude Code gates project-scope MCP
# declarations behind an explicit allow-list (`enabledMcpjsonServers` in
# ~/.claude.json > projects.<path>). When that list is empty, the project
# declaration is silently dropped — AND it overrides the user-scope one we
# just registered, so the server never appears in the session's tool list.
# Explicitly whitelist transaction-builder for this project so the next
# session picks it up on handshake.
CLAUDE_JSON="$HOME/.claude.json"
if [[ -s "$CLAUDE_JSON" ]]; then
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const project = process.argv[2];
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); }
    catch { console.error("  ! ~/.claude.json is not valid JSON — skipping project-scope whitelist."); process.exit(0); }
    cfg.projects = cfg.projects || {};
    cfg.projects[project] = cfg.projects[project] || {};
    const p = cfg.projects[project];
    p.enabledMcpjsonServers = Array.isArray(p.enabledMcpjsonServers) ? p.enabledMcpjsonServers : [];
    if (!p.enabledMcpjsonServers.includes("transaction-builder")) {
      p.enabledMcpjsonServers.push("transaction-builder");
      // Atomic write: tmp file + rename.
      const tmp = path + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
      fs.renameSync(tmp, path);
      console.log("  ↳ Whitelisted project-scope transaction-builder in ~/.claude.json (enabledMcpjsonServers).");
    } else {
      console.log("  ↳ Project-scope transaction-builder already whitelisted in ~/.claude.json.");
    }
  ' "$CLAUDE_JSON" "$PROJECT_ROOT"
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
link "$PROJECT_ROOT/.claude/skills/create-transaction" "$CLI_SKILLS/create-transaction"
link "$PROJECT_ROOT/.claude/skills/sync-rules"         "$CLI_SKILLS/sync-rules"

# Remove any legacy agent symlink from a previous install.
if [[ -L "$CLI_AGENTS/transaction-creator.md" ]]; then
  rm -f "$CLI_AGENTS/transaction-creator.md"
  echo "  ✗ Removed legacy ~/.claude/agents/transaction-creator.md symlink (subagents don't work with our MCP pattern)."
fi

echo ""
echo "→ Restart Claude Desktop (⌘Q + relaunch) or Claude CLI to pick up the change."
