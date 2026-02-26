import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { getDb } from "./state.js";
import { createAgent, getAgent, listAgents, removeAgent } from "./agents.js";
import { registerServer, registerLocalServer, listTools, callTool, disconnectAll } from "./tools/registry.js";
import { listRuns, getRun } from "./traces.js";
import { filesystemServerConfig } from "./tools/builtin/filesystem.js";
import { shellTools } from "./tools/builtin/shell.js";
import { gitTools } from "./tools/builtin/git.js";
import { discoverMcpServers } from "./tools/discovery.js";
import { initScheduler, stopScheduler, scheduleAgent, unscheduleAgent } from "./scheduler.js";
const startTime = Date.now();
const app = new Hono();
app.get("/health", (c) => {
    return c.json({
        status: "ok",
        version: "0.1.0",
        uptime: Math.floor((Date.now() - startTime) / 1000),
    });
});
app.get("/agents", (c) => {
    return c.json(listAgents());
});
app.get("/agents/:name", (c) => {
    const agent = getAgent(c.req.param("name"));
    if (!agent)
        return c.json({ error: `Agent "${c.req.param("name")}" not found` }, 404);
    return c.json(agent);
});
app.post("/agents", async (c) => {
    const body = await c.req.json();
    if (!body.yamlPath)
        return c.json({ error: "Missing yamlPath in request body" }, 400);
    try {
        const agent = createAgent(body.yamlPath);
        scheduleAgent(agent.name, agent.triggers);
        return c.json(agent, 201);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE constraint failed")) {
            return c.json({ error: "Agent already exists" }, 409);
        }
        return c.json({ error: msg }, 400);
    }
});
app.delete("/agents/:name", (c) => {
    const name = c.req.param("name");
    unscheduleAgent(name);
    const removed = removeAgent(name);
    if (!removed)
        return c.json({ error: `Agent "${name}" not found` }, 404);
    return c.body(null, 204);
});
app.post("/agents/:name/run", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => ({}));
    try {
        const { runAgent } = await import("./runner.js");
        const result = await runAgent(name, "context" in body ? body.context : undefined);
        return c.json(result);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found"))
            return c.json({ error: msg }, 404);
        if (msg.includes("API key"))
            return c.json({ error: msg }, 500);
        return c.json({ error: msg }, 500);
    }
});
app.get("/agents/:name/runs", (c) => {
    const name = c.req.param("name");
    const limit = Number(c.req.query("limit")) || 20;
    return c.json(listRuns(name, limit));
});
app.get("/runs/:id", (c) => {
    try {
        const run = getRun(c.req.param("id"));
        if (!run)
            return c.json({ error: "Run not found" }, 404);
        return c.json(run);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Ambiguous"))
            return c.json({ error: msg }, 400);
        return c.json({ error: msg }, 500);
    }
});
app.get("/tools", (c) => {
    return c.json(listTools());
});
app.post("/tools/call", async (c) => {
    const body = await c.req.json();
    if (!body.tool)
        return c.json({ error: "Missing 'tool' field in request body" }, 400);
    try {
        const result = await callTool(body.tool, body.args);
        return c.json(result);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 400);
    }
});
export { app };
async function initTools() {
    try {
        const config = filesystemServerConfig();
        await registerServer("filesystem", config, "built-in");
        console.log("Registered MCP server: filesystem (source: built-in)");
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: failed to register filesystem MCP server: ${msg}`);
    }
    registerLocalServer("shell", shellTools, "built-in");
    console.log("Registered local tools: shell (source: built-in)");
    registerLocalServer("git", gitTools, "built-in");
    console.log("Registered local tools: git (source: built-in)");
    await discoverMcpServers();
}
export async function startServer() {
    const config = loadConfig();
    getDb(); // initialize database on startup
    await initTools();
    initScheduler();
    serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
        console.log(`agentd listening on ${info.address}:${info.port}`);
    });
}
async function shutdown() {
    stopScheduler();
    await disconnectAll();
    process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// When run directly as a detached child, start the server.
// import.meta.url ends with /server.ts; process.argv[1] is the file node was invoked with.
const isDirectRun = process.argv[1] &&
    import.meta.url.endsWith(process.argv[1].replace(/.*(?=\/src\/)/, ""));
if (isDirectRun) {
    startServer().catch((err) => {
        console.error("Failed to start server:", err);
        process.exit(1);
    });
}
