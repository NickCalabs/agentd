import { Command } from "commander";
import { resolve } from "node:path";
import { start, stop, status } from "./daemon.ts";
import { DEFAULT_PORT, DEFAULT_HOST } from "./config.ts";

const BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

const program = new Command();

program
  .name("agentd")
  .description("Universal agent runtime daemon")
  .version("0.1.0");

program
  .command("start")
  .description("Start the agentd daemon")
  .action(start);

program
  .command("stop")
  .description("Stop the agentd daemon")
  .action(stop);

program
  .command("status")
  .description("Show daemon status")
  .action(status);

program
  .command("run <agent-name>")
  .description("Run an agent")
  .option("--context <text>", "Context to pass to the agent")
  .action(async (agentName: string, opts: { context?: string }) => {
    try {
      console.error(`Running ${agentName}...`);
      const res = await fetch(`${BASE_URL}/agents/${encodeURIComponent(agentName)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: opts.context }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error: string };
        console.error(`Error: ${body.error}`);
        process.exitCode = 1;
        return;
      }
      const result = (await res.json()) as { output: string };
      console.log(result.output);
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

const agents = program
  .command("agents")
  .description("Manage agents");

agents
  .command("list")
  .description("List registered agents")
  .action(async () => {
    try {
      const res = await fetch(`${BASE_URL}/agents`);
      const data = (await res.json()) as { name: string; model: string; description: string | null }[];
      if (data.length === 0) {
        console.log("No agents registered.");
        return;
      }
      console.log("Name\tModel\tDescription");
      for (const a of data) {
        console.log(`${a.name}\t${a.model}\t${a.description ?? ""}`);
      }
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

agents
  .command("add <path>")
  .description("Register an agent from a YAML file")
  .action(async (path: string) => {
    try {
      const yamlPath = resolve(path);
      const res = await fetch(`${BASE_URL}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yamlPath }),
      });
      if (res.ok) {
        const agent = (await res.json()) as { name: string };
        console.log(`Agent "${agent.name}" registered.`);
      } else {
        const body = (await res.json()) as { error: string };
        console.error(`Error: ${body.error}`);
        process.exitCode = 1;
      }
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

agents
  .command("remove <name>")
  .description("Remove a registered agent")
  .action(async (name: string) => {
    try {
      const res = await fetch(`${BASE_URL}/agents/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.status === 204) {
        console.log(`Agent "${name}" removed.`);
      } else {
        const body = (await res.json()) as { error: string };
        console.error(`Error: ${body.error}`);
        process.exitCode = 1;
      }
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

const tools = program
  .command("tools")
  .description("Manage tools");

tools
  .command("list")
  .description("List available tools")
  .action(async () => {
    try {
      const res = await fetch(`${BASE_URL}/tools`);
      const data = (await res.json()) as { name: string; serverName: string; description?: string }[];
      if (data.length === 0) {
        console.log("No tools available.");
        return;
      }
      console.log("Tool\tServer\tDescription");
      for (const t of data) {
        console.log(`${t.name}\t${t.serverName}\t${t.description ?? ""}`);
      }
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

program.parse();
