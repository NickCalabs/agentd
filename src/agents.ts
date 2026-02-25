import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getDb } from "./state.ts";

export interface Agent {
  name: string;
  description: string | null;
  model: string;
  prompt: string;
  tools: string[];
  triggers: string[];
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  name: string;
  description: string | null;
  model: string;
  prompt: string;
  tools: string;
  triggers: string;
  created_at: string;
  updated_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    ...row,
    tools: JSON.parse(row.tools),
    triggers: JSON.parse(row.triggers),
  };
}

export function createAgent(yamlPath: string): Agent {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid YAML in ${yamlPath}: expected a mapping`);
  }

  const { name, model, prompt, description, tools, triggers } = parsed as {
    name?: string;
    model?: string;
    prompt?: string;
    description?: string;
    tools?: string[];
    triggers?: string[];
  };

  if (!name) throw new Error("Agent YAML is missing required field: name");
  if (!model) throw new Error("Agent YAML is missing required field: model");
  if (!prompt) throw new Error("Agent YAML is missing required field: prompt");

  const now = new Date().toISOString();
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO agents (name, description, model, prompt, tools, triggers, created_at, updated_at)
    VALUES (@name, @description, @model, @prompt, @tools, @triggers, @created_at, @updated_at)
  `);

  stmt.run({
    name,
    description: description ?? null,
    model,
    prompt,
    tools: JSON.stringify(tools ?? []),
    triggers: JSON.stringify(triggers ?? []),
    created_at: now,
    updated_at: now,
  });

  return {
    name,
    description: description ?? null,
    model,
    prompt,
    tools: tools ?? [],
    triggers: triggers ?? [],
    created_at: now,
    updated_at: now,
  };
}

export function getAgent(name: string): Agent | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function listAgents(): Agent[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agents ORDER BY created_at").all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function removeAgent(name: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM agents WHERE name = ?").run(name);
  return result.changes > 0;
}
