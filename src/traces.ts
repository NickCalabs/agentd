import { randomUUID } from "node:crypto";
import { getDb } from "./state.ts";

interface RunRow {
  id: string;
  agent_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  cost_usd: number;
  tool_calls: number;
  output: string | null;
  error: string | null;
}

interface EventRow {
  id: number;
  run_id: string;
  type: string;
  timestamp: string;
  data: string | null;
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250514": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
};

export function costForModel(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

export function createRun(agentName: string): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO runs (id, agent_name, status, started_at) VALUES (@id, @agent_name, @status, @started_at)",
  ).run({
    id,
    agent_name: agentName,
    status: "running",
    started_at: new Date().toISOString(),
  });
  return id;
}

export function completeRun(
  runId: string,
  params: {
    output: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    costUsd: number;
    toolCalls: number;
    durationMs: number;
  },
): void {
  const db = getDb();
  db.prepare(
    `UPDATE runs SET
      status = 'completed',
      completed_at = @completed_at,
      duration_ms = @duration_ms,
      total_input_tokens = @total_input_tokens,
      total_output_tokens = @total_output_tokens,
      cost_usd = @cost_usd,
      tool_calls = @tool_calls,
      output = @output
    WHERE id = @id`,
  ).run({
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

export function failRun(runId: string, params: { error: string; durationMs: number }): void {
  const db = getDb();
  db.prepare(
    `UPDATE runs SET
      status = 'error',
      completed_at = @completed_at,
      duration_ms = @duration_ms,
      error = @error
    WHERE id = @id`,
  ).run({
    id: runId,
    completed_at: new Date().toISOString(),
    duration_ms: params.durationMs,
    error: params.error,
  });
}

export function logEvent(runId: string, type: string, data: unknown): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO events (run_id, type, timestamp, data) VALUES (@run_id, @type, @timestamp, @data)",
  ).run({
    run_id: runId,
    type,
    timestamp: new Date().toISOString(),
    data: JSON.stringify(data),
  });
}

export function getRun(runId: string): (RunRow & { events: (Omit<EventRow, "data"> & { data: unknown })[] }) | null {
  const db = getDb();

  // Try exact match first
  let run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;

  if (!run) {
    // Fall back to prefix match
    const matches = db.prepare("SELECT * FROM runs WHERE id LIKE ? || '%'").all(runId) as RunRow[];
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error("Ambiguous run ID prefix, be more specific");
    }
    run = matches[0];
  }

  const events = db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id ASC").all(run.id) as EventRow[];

  return {
    ...run,
    events: events.map((e) => ({
      ...e,
      data: e.data ? JSON.parse(e.data) : null,
    })),
  };
}

export function listRuns(agentName: string, limit = 20): RunRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM runs WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?")
    .all(agentName, limit) as RunRow[];
}
