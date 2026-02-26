import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getDb } from "./state.js";
const require = createRequire(import.meta.url);
const nodeCron = require("node-cron");
const cronParser = require("cron-parser");
function rowToAgent(row) {
    return {
        ...row,
        tools: JSON.parse(row.tools),
        triggers: JSON.parse(row.triggers),
        next_run: row.next_run ?? null,
    };
}
const MODEL_PATTERN = /^claude-/;
function validateStringArray(value, field) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value)) {
        throw new Error(`"${field}" must be an array, got ${typeof value}`);
    }
    for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string") {
            throw new Error(`"${field}[${i}]" must be a string, got ${typeof value[i]}`);
        }
    }
    return value;
}
export function createAgent(yamlPath) {
    let raw;
    try {
        raw = readFileSync(yamlPath, "utf-8");
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT")
            throw new Error(`File not found: ${yamlPath}`);
        if (code === "EISDIR")
            throw new Error(`Path is a directory, not a file: ${yamlPath}`);
        if (code === "EACCES")
            throw new Error(`Permission denied: ${yamlPath}`);
        throw new Error(`Cannot read ${yamlPath}: ${err.message}`);
    }
    let parsed;
    try {
        parsed = parseYaml(raw);
    }
    catch (err) {
        throw new Error(`Invalid YAML syntax in ${yamlPath}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid YAML in ${yamlPath}: expected a mapping (got ${parsed === null ? "null" : typeof parsed})`);
    }
    const doc = parsed;
    const name = doc.name;
    const model = doc.model;
    const prompt = doc.prompt;
    const description = doc.description;
    if (!name || typeof name !== "string")
        throw new Error("Agent YAML is missing required field: name");
    if (!model || typeof model !== "string")
        throw new Error("Agent YAML is missing required field: model");
    if (!prompt || typeof prompt !== "string")
        throw new Error("Agent YAML is missing required field: prompt");
    if (description !== undefined && typeof description !== "string") {
        throw new Error(`"description" must be a string, got ${typeof description}`);
    }
    if (!MODEL_PATTERN.test(model)) {
        throw new Error(`Unknown model "${model}". Model must start with "claude-" (e.g. "claude-sonnet-4-20250514")`);
    }
    const tools = validateStringArray(doc.tools, "tools");
    const triggers = validateStringArray(doc.triggers, "triggers");
    // Validate trigger format
    for (const trigger of triggers) {
        if (trigger === "manual")
            continue;
        if (trigger.startsWith("cron:")) {
            const expr = trigger.slice(5);
            if (!expr.trim()) {
                throw new Error(`Empty cron expression in trigger "${trigger}"`);
            }
            if (!nodeCron.validate(expr)) {
                throw new Error(`Invalid cron expression in trigger "${trigger}"`);
            }
            // Also verify cron-parser can compute next run
            try {
                cronParser.CronExpressionParser.parse(expr);
            }
            catch {
                throw new Error(`Invalid cron expression in trigger "${trigger}"`);
            }
            continue;
        }
        const prefix = trigger.split(":")[0];
        throw new Error(`Unknown trigger type "${prefix}" in trigger "${trigger}". Supported types: manual, cron`);
    }
    // Compute next_run from cron triggers
    let nextRun = null;
    const cronExprs = triggers.filter((t) => t.startsWith("cron:")).map((t) => t.slice(5));
    if (cronExprs.length > 0) {
        const now = new Date();
        let earliest = null;
        for (const expr of cronExprs) {
            const parsed = cronParser.CronExpressionParser.parse(expr);
            const next = parsed.next().toDate();
            if (!earliest || next < earliest)
                earliest = next;
        }
        if (earliest)
            nextRun = earliest.toISOString();
    }
    const now = new Date().toISOString();
    const db = getDb();
    const stmt = db.prepare(`
    INSERT INTO agents (name, description, model, prompt, tools, triggers, next_run, created_at, updated_at)
    VALUES (@name, @description, @model, @prompt, @tools, @triggers, @next_run, @created_at, @updated_at)
  `);
    const desc = description ?? null;
    stmt.run({
        name,
        description: desc,
        model,
        prompt,
        tools: JSON.stringify(tools),
        triggers: JSON.stringify(triggers),
        next_run: nextRun,
        created_at: now,
        updated_at: now,
    });
    return {
        name: name,
        description: desc,
        model: model,
        prompt: prompt,
        tools,
        triggers,
        next_run: nextRun,
        created_at: now,
        updated_at: now,
    };
}
export function getAgent(name) {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
    return row ? rowToAgent(row) : null;
}
export function listAgents() {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM agents ORDER BY created_at").all();
    return rows.map(rowToAgent);
}
export function removeAgent(name) {
    const db = getDb();
    const result = db.prepare("DELETE FROM agents WHERE name = ?").run(name);
    return result.changes > 0;
}
