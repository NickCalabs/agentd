# CLAUDE.md

## Project: agentd
Universal agent runtime daemon. TypeScript, Node 22+, pnpm.

## Conventions
- ESM only (`"type": "module"` in package.json)
- Run TS directly via `node --experimental-strip-types`
- Hono for HTTP
- Commander for CLI
- Vitest for tests
- No build step in dev
- All state lives in ~/.agentd/
- Daemon listens on localhost:4700
- CLI commands are thin HTTP clients over the daemon REST API
- SQLite database at ~/.agentd/agentd.db, opened only by the server process
- Tools are namespaced as <server>.<tool> (e.g., "filesystem.read_file")
- Anthropic API tool names use double underscore (filesystem__read_file) since dots aren't allowed

## Structure
src/index.ts — CLI entry point
src/daemon.ts — start/stop/status
src/server.ts — HTTP routes
src/config.ts — YAML config loader
src/state.ts  — SQLite database (better-sqlite3)
src/agents.ts — Agent CRUD operations
src/runner.ts — Agent execution loop (Anthropic API + tool calls)
src/traces.ts — Run tracing and cost tracking
src/tools/registry.ts  — Tool registry (namespaced tools from MCP servers)
src/tools/mcp-client.ts — MCP client wrapper (stdio transport)
src/tools/builtin/filesystem.ts — Built-in filesystem MCP server config

## Schema
- agents — Agent definitions
- state — Agent key-value state
- runs — Agent execution runs (traces, token counts, cost)
- events — Per-run events (llm_call, tool_call, error)

## Rules
- No classes unless necessary. Prefer plain functions and objects.
- All errors must include actionable messages.
- Every new route gets a test.