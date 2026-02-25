import { createRequire } from "node:module";
import { join } from "node:path";
import type DatabaseConstructor from "better-sqlite3";
import { AGENTD_DIR, ensureAgentdDir } from "./config.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof DatabaseConstructor;

export const DB_PATH = join(AGENTD_DIR, "agentd.db");

let db: InstanceType<typeof DatabaseConstructor> | null = null;

export function getDb(): InstanceType<typeof DatabaseConstructor> {
  if (db) return db;

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
  `);

  return db;
}
