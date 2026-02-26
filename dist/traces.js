import { randomUUID } from "node:crypto";
import { getDb } from "./state.js";
const MODEL_PRICING = [
    { prefix: "claude-sonnet-4-5", input: 3, output: 15 },
    { prefix: "claude-sonnet-4", input: 3, output: 15 },
    { prefix: "claude-haiku-4", input: 0.8, output: 4 },
    { prefix: "claude-opus-4", input: 15, output: 75 },
];
export function costForModel(model, inputTokens, outputTokens) {
    const pricing = MODEL_PRICING.find((p) => model.startsWith(p.prefix));
    if (!pricing)
        return 0;
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
export function createRun(agentName) {
    const db = getDb();
    const id = randomUUID();
    db.prepare("INSERT INTO runs (id, agent_name, status, started_at) VALUES (@id, @agent_name, @status, @started_at)").run({
        id,
        agent_name: agentName,
        status: "running",
        started_at: new Date().toISOString(),
    });
    return id;
}
export function completeRun(runId, params) {
    const db = getDb();
    db.prepare(`UPDATE runs SET
      status = 'completed',
      completed_at = @completed_at,
      duration_ms = @duration_ms,
      total_input_tokens = @total_input_tokens,
      total_output_tokens = @total_output_tokens,
      cost_usd = @cost_usd,
      tool_calls = @tool_calls,
      output = @output
    WHERE id = @id`).run({
        id: runId,
        completed_at: new Date().toISOString(),
        duration_ms: params.durationMs,
        total_input_tokens: params.totalInputTokens,
        total_output_tokens: params.totalOutputTokens,
        cost_usd: params.costUsd,
        tool_calls: params.toolCalls,
        output: params.output,
    });
}
export function failRun(runId, params) {
    const db = getDb();
    db.prepare(`UPDATE runs SET
      status = 'error',
      completed_at = @completed_at,
      duration_ms = @duration_ms,
      error = @error
    WHERE id = @id`).run({
        id: runId,
        completed_at: new Date().toISOString(),
        duration_ms: params.durationMs,
        error: params.error,
    });
}
export function logEvent(runId, type, data) {
    const db = getDb();
    db.prepare("INSERT INTO events (run_id, type, timestamp, data) VALUES (@run_id, @type, @timestamp, @data)").run({
        run_id: runId,
        type,
        timestamp: new Date().toISOString(),
        data: JSON.stringify(data),
    });
}
export function getRun(runId) {
    const db = getDb();
    // Try exact match first
    let run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!run) {
        // Fall back to prefix match
        const matches = db.prepare("SELECT * FROM runs WHERE id LIKE ? || '%'").all(runId);
        if (matches.length === 0)
            return null;
        if (matches.length > 1) {
            throw new Error("Ambiguous run ID prefix, be more specific");
        }
        run = matches[0];
    }
    const events = db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id ASC").all(run.id);
    return {
        ...run,
        events: events.map((e) => ({
            ...e,
            data: e.data ? JSON.parse(e.data) : null,
        })),
    };
}
export function listRuns(agentName, limit = 20) {
    const db = getDb();
    return db
        .prepare("SELECT * FROM runs WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?")
        .all(agentName, limit);
}
