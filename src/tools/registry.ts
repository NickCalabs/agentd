import type { McpClient, McpClientOptions } from "./mcp-client.ts";
import { createMcpClient } from "./mcp-client.ts";

export interface RegisteredTool {
  name: string;
  serverName: string;
  originalName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ServerEntry {
  client: McpClient;
  tools: Map<string, RegisteredTool>;
}

const servers = new Map<string, ServerEntry>();

export async function registerServer(
  name: string,
  config: McpClientOptions,
): Promise<RegisteredTool[]> {
  const client = await createMcpClient(config);
  const rawTools = await client.listTools();

  const tools = new Map<string, RegisteredTool>();
  for (const t of rawTools) {
    const namespacedName = `${name}.${t.name}`;
    tools.set(t.name, {
      name: namespacedName,
      serverName: name,
      originalName: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }

  servers.set(name, { client, tools });
  return [...tools.values()];
}

export function listTools(): RegisteredTool[] {
  const all: RegisteredTool[] = [];
  for (const entry of servers.values()) {
    all.push(...entry.tools.values());
  }
  return all;
}

function getServerForTool(toolName: string): { server: ServerEntry; originalName: string } {
  const dotIndex = toolName.indexOf(".");
  if (dotIndex === -1) {
    throw new Error(`Invalid tool name "${toolName}": expected format <server>.<tool>`);
  }

  const serverName = toolName.slice(0, dotIndex);
  const originalName = toolName.slice(dotIndex + 1);

  const server = servers.get(serverName);
  if (!server) {
    throw new Error(`Server "${serverName}" not found. Available servers: ${[...servers.keys()].join(", ") || "none"}`);
  }

  if (!server.tools.has(originalName)) {
    throw new Error(`Tool "${toolName}" not found on server "${serverName}". Available tools: ${[...server.tools.keys()].join(", ")}`);
  }

  return { server, originalName };
}

export async function callTool(
  toolName: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { server, originalName } = getServerForTool(toolName);
  return server.client.callTool(originalName, args);
}

export async function disconnectAll(): Promise<void> {
  const entries = [...servers.values()];
  servers.clear();
  await Promise.allSettled(entries.map((e) => e.client.disconnect()));
}
