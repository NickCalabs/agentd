import type { RegisteredTool } from "./tools/registry.ts";
interface OllamaFunction {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
interface OllamaTool {
    type: "function";
    function: OllamaFunction;
}
export declare function toOllamaToolName(name: string): string;
export declare function fromOllamaToolName(name: string): string;
export declare function convertToolsToOllamaFormat(tools: RegisteredTool[]): OllamaTool[];
interface OllamaRunResult {
    output: string;
    totalToolCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
}
export declare function runOllamaLoop(opts: {
    model: string;
    systemPrompt: string;
    tools: OllamaTool[];
    resolvedTools: RegisteredTool[];
    initialMessage: string;
    runId: string;
    maxTokens: number;
}): Promise<OllamaRunResult>;
export {};
