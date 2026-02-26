import { createRequire } from "node:module";
import { join } from "node:path";
import { AGENTD_DIR, ensureAgentdDir } from "./config.js";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
export const DB_PATH = join(AGENTD_DIR, "agentd.db");
let db = null;
export function getDb() {
    if (db)
        return db;
    ensureAgentdDir();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
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
    const columns = db.pragma("table_info(agents)");
    if (!columns.some((c) => c.name === "next_run")) {
        db.exec("ALTER TABLE agents ADD COLUMN next_run TEXT");
    }
    return db;
}
