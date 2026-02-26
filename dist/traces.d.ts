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
export declare function costForModel(model: string, inputTokens: number, outputTokens: number): number;
export declare function createRun(agentName: string): string;
export declare function completeRun(runId: string, params: {
    output: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    costUsd: number;
    toolCalls: number;
    durationMs: number;
}): void;
export declare function failRun(runId: string, params: {
    error: string;
    durationMs: number;
}): void;
export declare function logEvent(runId: string, type: string, data: unknown): void;
export declare function getRun(runId: string): (RunRow & {
    events: (Omit<EventRow, "data"> & {
        data: unknown;
    })[];
}) | null;
export declare function listRuns(agentName: string, limit?: number): RunRow[];
export {};
