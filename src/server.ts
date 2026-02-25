import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { getDb } from "./state.ts";
import { createAgent, getAgent, listAgents, removeAgent } from "./agents.ts";
import { registerServer, listTools, callTool, disconnectAll } from "./tools/registry.ts";
import { listRuns, getRun } from "./traces.ts";
import { filesystemServerConfig } from "./tools/builtin/filesystem.ts";

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
  if (!agent) return c.json({ error: `Agent "${c.req.param("name")}" not found` }, 404);
  return c.json(agent);
});

app.post("/agents", async (c) => {
  const body = await c.req.json<{ yamlPath?: string }>();
  if (!body.yamlPath) return c.json({ error: "Missing yamlPath in request body" }, 400);

  try {
    const agent = createAgent(body.yamlPath);
    return c.json(agent, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint failed")) {
      return c.json({ error: "Agent already exists" }, 409);
    }
    return c.json({ error: msg }, 400);
  }
});

app.delete("/agents/:name", (c) => {
  const removed = removeAgent(c.req.param("name"));
  if (!removed) return c.json({ error: `Agent "${c.req.param("name")}" not found` }, 404);
  return c.body(null, 204);
});

app.post("/agents/:name/run", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json<{ context?: string }>().catch(() => ({}));

  try {
    const { runAgent } = await import("./runner.ts");
    const result = await runAgent(name, body.context);
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) return c.json({ error: msg }, 404);
    if (msg.includes("API key")) return c.json({ error: msg }, 500);
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
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json(run);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Ambiguous")) return c.json({ error: msg }, 400);
    return c.json({ error: msg }, 500);
  }
});

app.get("/tools", (c) => {
  return c.json(listTools());
});

app.post("/tools/call", async (c) => {
  const body = await c.req.json<{ tool?: string; args?: Record<string, unknown> }>();
  if (!body.tool) return c.json({ error: "Missing 'tool' field in request body" }, 400);

  try {
    const result = await callTool(body.tool, body.args);
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

export { app };

async function initTools(): Promise<void> {
  try {
    const config = filesystemServerConfig();
    await registerServer("filesystem", config);
    console.log("Registered MCP server: filesystem");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: failed to register filesystem MCP server: ${msg}`);
  }
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  getDb(); // initialize database on startup
  await initTools();
  serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      console.log(`agentd listening on ${info.address}:${info.port}`);
    },
  );
}

async function shutdown(): Promise<void> {
  await disconnectAll();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// When run directly as a detached child, start the server.
// import.meta.url ends with /server.ts; process.argv[1] is the file node was invoked with.
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*(?=\/src\/)/, ""));

if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
