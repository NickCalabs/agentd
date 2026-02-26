import type { McpClient, McpClientOptions } from "./mcp-client.ts";
import { createMcpClient } from "./mcp-client.ts";

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
  handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
}

interface ServerEntry {
  client: McpClient | null;
  tools: Map<string, RegisteredTool>;
  localHandlers?: Map<string, LocalToolDef["handler"]>;
  source: string;
}

const servers = new Map<string, ServerEntry>();

export async function registerServer(
  name: string,
  config: McpClientOptions,
  source = "manual",
  opts?: { replace?: boolean },
): Promise<RegisteredTool[]> {
  const existing = servers.get(name);
  if (existing) {
    if (opts?.replace) {
      await existing.client.disconnect().catch(() => {});
    } else {
      console.warn(`MCP server "${name}" already registered (source: ${existing.source}), skipping`);
      return [...existing.tools.values()];
    }
  }

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
      source,
    });
  }

  servers.set(name, { client, tools, source });
  return [...tools.values()];
}

export function registerLocalServer(name: string, toolDefs: LocalToolDef[], source = "built-in"): RegisteredTool[] {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, LocalToolDef["handler"]>();

  for (const t of toolDefs) {
    const namespacedName = `${name}.${t.name}`;
    tools.set(t.name, {
      name: namespacedName,
      serverName: name,
      originalName: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      source,
    });
    handlers.set(t.name, t.handler);
  }

  servers.set(name, { client: null, tools, localHandlers: handlers, source });
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

  // Local handler (no MCP subprocess)
  if (server.localHandlers) {
    const handler = server.localHandlers.get(originalName);
    if (handler) return handler(args ?? {});
  }

  return server.client!.callTool(originalName, args);
}

export async function disconnectAll(): Promise<void> {
  const entries = [...servers.values()];
  servers.clear();
  await Promise.allSettled(entries.map((e) => e.client.disconnect()));
}
