import { createRequire } from "node:module";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { AGENTD_DIR, ensureAgentdDir } from "./config.ts";

const require = createRequire(import.meta.url);
const { Database } = require("node-sqlite3-wasm") as {
  Database: new (path: string) => RawDb;
};

interface RawDb {
  exec(sql: string): void;
  run(sql: string, values?: unknown): { changes: number; lastInsertRowid: number };
  get(sql: string, values?: unknown): Record<string, unknown> | undefined;
  all(sql: string, values?: unknown): Record<string, unknown>[];
  close(): void;
}

// Compatibility layer matching the better-sqlite3 API surface used by this project
interface RunResult {
  changes: number;
}

interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface CompatDb {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

export const DB_PATH = join(AGENTD_DIR, "agentd.db");

let db: CompatDb | null = null;

function normalizeParams(params: unknown[]): unknown | undefined {
  if (params.length === 0) return undefined;
  if (params.length === 1) {
    const p = params[0];
    if (p !== null && p !== undefined && typeof p === "object" && !Array.isArray(p)) {
      // Named params: better-sqlite3 uses { name: val } with @name in SQL
      // node-sqlite3-wasm uses { "@name": val } — add the @ prefix
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
        mapped[`@${k}`] = v;
      }
      return mapped;
    }
    return p;
  }
  // Multiple positional args → array
  return params;
}

export function getDb(): CompatDb {
  if (db) return db;

  ensureAgentdDir();

  // Clean up stale WAL/SHM files from previous better-sqlite3 installs
  // node-sqlite3-wasm's VFS cannot open databases with leftover native WAL state
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(DB_PATH + suffix); } catch { /* doesn't exist */ }
  }

  const rawDb = new Database(DB_PATH);
  // node-sqlite3-wasm enables foreign keys by default

  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name        TEXT PRIMARY KEY,
      description TEXT,
      model       TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      tools       TEXT DEFAULT '[]',
      triggers    TEXT DEFAULT '[]',
      created_at  TEXT,
      updated_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS state (
      agent_name  TEXT,
      key         TEXT,
      value       TEXT,
      updated_at  TEXT,
      PRIMARY KEY (agent_name, key),
      FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runs (
      id                  TEXT PRIMARY KEY,
      agent_name          TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'running',
      started_at          TEXT NOT NULL,
      completed_at        TEXT,
      duration_ms         INTEGER,
      total_input_tokens  INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      cost_usd            REAL DEFAULT 0,
      tool_calls          INTEGER DEFAULT 0,
      output              TEXT,
      error               TEXT,
      FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    TEXT NOT NULL,
      type      TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data      TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
  `);

  // Migrations
  const columns = rawDb.all("PRAGMA table_info(agents)") as { name: string }[];
  if (!columns.some((c) => c.name === "next_run")) {
    rawDb.exec("ALTER TABLE agents ADD COLUMN next_run TEXT");
  }

  db = {
    exec: (sql: string) => rawDb.exec(sql),
    prepare: (sql: string) => ({
      run: (...params: unknown[]): RunResult => rawDb.run(sql, normalizeParams(params)),
      get: (...params: unknown[]) => rawDb.get(sql, normalizeParams(params)),
      all: (...params: unknown[]) => rawDb.all(sql, normalizeParams(params)),
    }),
  };

  return db;
}
