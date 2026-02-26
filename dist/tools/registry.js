import { createMcpClient } from "./mcp-client.js";
const servers = new Map();
export async function registerServer(name, config, source = "manual", opts) {
    const existing = servers.get(name);
    if (existing) {
        if (opts?.replace) {
            await existing.client?.disconnect().catch(() => { });
        }
        else {
            console.warn(`MCP server "${name}" already registered (source: ${existing.source}), skipping`);
            return [...existing.tools.values()];
        }
    }
    const client = await createMcpClient(config);
    const rawTools = await client.listTools();
    const tools = new Map();
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
export function registerLocalServer(name, toolDefs, source = "built-in") {
    const tools = new Map();
    const handlers = new Map();
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
export function listTools() {
    const all = [];
    for (const entry of servers.values()) {
        all.push(...entry.tools.values());
    }
    return all;
}
function getServerForTool(toolName) {
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
export async function callTool(toolName, args) {
    const { server, originalName } = getServerForTool(toolName);
    // Local handler (no MCP subprocess)
    if (server.localHandlers) {
        const handler = server.localHandlers.get(originalName);
        if (handler)
            return handler(args ?? {});
    }
    return server.client.callTool(originalName, args);
}
export async function disconnectAll() {
    const entries = [...servers.values()];
    servers.clear();
    await Promise.allSettled(entries.map((e) => e.client?.disconnect()));
}
