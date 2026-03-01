import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export async function createMcpClient(options) {
    const transport = new StdioClientTransport({
        command: options.command,
        args: options.args,
        env: options.env ? { ...process.env, ...options.env } : undefined,
    });
    const client = new Client({ name: "agentd", version: "0.1.0" });
    await client.connect(transport);
    return {
        async listTools() {
            const result = await client.listTools();
            return result.tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            }));
        },
        async callTool(name, args) {
            const result = await client.callTool({ name, arguments: args });
            return {
                content: result.content,
                isError: result.isError,
            };
        },
        async disconnect() {
            try {
                await Promise.race([
                    client.close(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("MCP client disconnect timed out after 5s")), 5_000)),
                ]);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`MCP client disconnect failed: ${msg}`);
            }
        },
    };
}
