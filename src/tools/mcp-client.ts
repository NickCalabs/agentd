import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

export async function createMcpClient(options: McpClientOptions): Promise<McpClient> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    env: options.env ? { ...process.env, ...options.env } as Record<string, string> : undefined,
  });

  const client = new Client({ name: "agentd", version: "0.1.0" });
  await client.connect(transport);

  return {
    async listTools(): Promise<McpTool[]> {
      const result = await client.listTools();
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }));
    },

    async callTool(name: string, args?: Record<string, unknown>): Promise<McpToolResult> {
      const result = await client.callTool({ name, arguments: args });
      return {
        content: result.content as unknown[],
        isError: result.isError,
      };
    },

    async disconnect(): Promise<void> {
      try {
        await client.close();
      } catch {
        // Process may already be gone during SIGTERM
      }
    },
  };
}
