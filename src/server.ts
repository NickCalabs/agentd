import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";

const startTime = Date.now();

const app = new Hono();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: "0.1.0",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

export { app };

export function startServer(): void {
  const config = loadConfig();
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
