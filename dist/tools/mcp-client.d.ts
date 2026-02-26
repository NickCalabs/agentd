export interface McpClientOptions {
    command: string;
    args: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
}
export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
export interface McpToolResult {
    content: unknown[];
    isError?: boolean;
}
export interface McpClient {
    listTools(): Promise<McpTool[]>;
    callTool(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
    disconnect(): Promise<void>;
}
export declare function createMcpClient(options: McpClientOptions): Promise<McpClient>;
