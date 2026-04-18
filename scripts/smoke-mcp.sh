#!/usr/bin/env bash
# Spawn the built MCP binary via stdio, send MCP `initialize` + `tools/list`,
# and verify it returns the expected number of tools. Exits 0 on success.
#
# Used by setup.sh as a post-build smoke test and can be run standalone to
# diagnose "tools aren't showing up" issues in Claude.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PROJECT_ROOT/dist/index.js"

if [[ ! -f "$BIN" ]]; then
  echo "✗ Binary missing at $BIN — run 'npm run build' first." >&2
  exit 1
fi

# Build two JSON-RPC frames (initialize + tools/list), pipe to the MCP, read
# exactly two response lines back.
RESPONSE=$({
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  sleep 0.3
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 0.5
} | node "$BIN" 2>/dev/null || true)

if [[ -z "$RESPONSE" ]]; then
  echo "✗ MCP server returned no output. It may have crashed during startup." >&2
  echo "  Try: node $BIN   (should sit silently; Ctrl+C to exit)"
  exit 1
fi

# Extract server name + tool count via node (installed, no jq dependency).
# Asserts three shape invariants that, if violated, cause Claude Desktop and
# Claude Code to silently drop the entire tools/list from this MCP (handshake
# succeeds, `claude mcp list` shows Connected, but `mcp__<server>__*` tools
# never land in the session's registry):
#   1. No `$ref` anywhere in inputSchema (zod-to-json-schema's default
#      $refStrategy dedupes reused sub-schemas; we pass $refStrategy: 'none').
#   2. No `$schema` meta-property at the root (the library emits it by
#      default and clients treat it as an extra top-level key = spec violation;
#      we strip it in server.ts).
#   3. Every tool's inputSchema.type === "object" (bare `anyOf`/`oneOf` from a
#      z.union() root trips strict client validators; we wrap with
#      `{ type: "object", ...schema }` in server.ts).
# All three have regressed before. Keep asserting.
SUMMARY=$(node -e '
  let buf = "";
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => {
    const lines = buf.trim().split("\n").filter(Boolean);
    try {
      const init = JSON.parse(lines[0]);
      const list = JSON.parse(lines[1]);
      if (!init.result || !init.result.serverInfo) {
        console.error("Unexpected initialize response: " + lines[0]);
        process.exit(2);
      }
      const { name, version } = init.result.serverInfo;
      const tools = (list.result && list.result.tools) || [];
      const withRef = tools
        .filter((t) => JSON.stringify(t.inputSchema || {}).includes("\"$ref\""))
        .map((t) => t.name);
      const withDollarSchema = tools
        .filter((t) => (t.inputSchema || {}).hasOwnProperty("$schema"))
        .map((t) => t.name);
      const badRootType = tools
        .filter((t) => (t.inputSchema || {}).type !== "object")
        .map((t) => t.name);
      const withTopCombinator = tools
        .filter((t) => {
          const s = t.inputSchema || {};
          return "anyOf" in s || "oneOf" in s || "allOf" in s;
        })
        .map((t) => t.name);
      console.log([
        name, version, tools.length,
        withRef.join(","),
        withDollarSchema.join(","),
        badRootType.join(","),
        withTopCombinator.join(",")
      ].join("|"));
      process.exit(0);
    } catch (e) {
      console.error("Could not parse MCP response: " + e.message);
      process.exit(2);
    }
  });
' <<<"$RESPONSE")

IFS='|' read -r NAME VERSION TOOL_COUNT REF_TOOLS SCHEMA_TOOLS BAD_ROOT_TOOLS TOP_COMBINATOR_TOOLS <<<"$SUMMARY"

if [[ -z "$NAME" || -z "$TOOL_COUNT" ]]; then
  echo "✗ MCP responded but didn't declare expected fields." >&2
  exit 1
fi

if [[ "$TOOL_COUNT" -lt 20 ]]; then
  echo "✗ MCP reports only $TOOL_COUNT tools — expected 20+. Build may be stale." >&2
  exit 1
fi

if [[ -n "$REF_TOOLS" ]]; then
  echo "✗ Tool inputSchema contains \$ref — Claude Desktop/Code will silently drop this MCP." >&2
  echo "  Affected tools: $REF_TOOLS" >&2
  echo "  Fix: pass { \$refStrategy: 'none' } to zodToJsonSchema in src/server.ts." >&2
  exit 1
fi

if [[ -n "$SCHEMA_TOOLS" ]]; then
  echo "✗ Tool inputSchema has a \$schema meta-property at the root — clients drop the tools/list." >&2
  echo "  Affected tools: $SCHEMA_TOOLS" >&2
  echo "  Fix: delete schema.\$schema after zodToJsonSchema() in src/server.ts." >&2
  exit 1
fi

if [[ -n "$BAD_ROOT_TOOLS" ]]; then
  echo "✗ Tool inputSchema has a non-object root (bare anyOf/oneOf from z.union) — clients drop the tools/list." >&2
  echo "  Affected tools: $BAD_ROOT_TOOLS" >&2
  echo "  Fix: wrap with { type: 'object', ...schema } in src/server.ts (already patched; check the ListToolsRequestSchema handler)." >&2
  exit 1
fi

if [[ -n "$TOP_COMBINATOR_TOOLS" ]]; then
  echo "✗ Tool inputSchema has top-level anyOf/oneOf/allOf — Anthropic Messages API rejects with:" >&2
  echo "    'input_schema does not support oneOf, allOf, or anyOf at the top level'" >&2
  echo "  Affected tools: $TOP_COMBINATOR_TOOLS" >&2
  echo "  Fix: flattenTopLevelCombinators in src/server.ts (already patched; check the ListToolsRequestSchema handler)." >&2
  exit 1
fi

echo "✓ MCP smoke-test passed."
echo "  Server : $NAME@$VERSION"
echo "  Tools  : $TOOL_COUNT exposed over stdio"
echo "  Shape  : no \$ref, no \$schema, all roots type: 'object', no top-level combinators"
