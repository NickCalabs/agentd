import type { McpClientOptions } from "./mcp-client.ts";
export interface RegisteredTool {
    name: string;
    serverName: string;
    originalName: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    source: string;
}
export interface LocalToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<{
        content: unknown[];
        isError?: boolean;
    }>;
}
export declare function registerServer(name: string, config: McpClientOptions, source?: string, opts?: {
    replace?: boolean;
}): Promise<RegisteredTool[]>;
export declare function registerLocalServer(name: string, toolDefs: LocalToolDef[], source?: string): RegisteredTool[];
export declare function listTools(): RegisteredTool[];
export declare function callTool(toolName: string, args?: Record<string, unknown>): Promise<unknown>;
export declare function disconnectServer(name: string): Promise<boolean>;
export declare function disconnectAll(): Promise<void>;
