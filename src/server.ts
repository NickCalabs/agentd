import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { getDb } from "./state.ts";
import { createAgent, getAgent, listAgents, removeAgent } from "./agents.ts";

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

export { app };

export function startServer(): void {
  const config = loadConfig();
  getDb(); // initialize database on startup
  serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      console.log(`agentd listening on ${info.address}:${info.port}`);
    },
  );
}

// When run directly as a detached child, start the server.
// import.meta.url ends with /server.ts; process.argv[1] is the file node was invoked with.
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*(?=\/src\/)/, ""));

if (isDirectRun) {
  startServer();
}
