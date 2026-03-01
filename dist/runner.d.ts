export interface RunResult {
    runId: string;
    agentName: string;
    output: string;
    toolCalls: number;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    costUsd: number;
}
export declare function toAnthropicName(name: string): string;
export declare function fromAnthropicName(name: string): string;
export declare function runAgent(agentName: string, runId: string, context?: string): Promise<RunResult>;
