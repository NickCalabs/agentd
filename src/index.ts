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

program
  .command("logs <agent-name>")
  .description("Show run history for an agent")
  .option("--limit <n>", "Number of runs to show", "20")
  .action(async (agentName: string, opts: { limit: string }) => {
    try {
      const limit = Number(opts.limit) || 20;
      const res = await fetch(
        `${BASE_URL}/agents/${encodeURIComponent(agentName)}/runs?limit=${limit}`,
      );
      const runs = (await res.json()) as {
        id: string;
        status: string;
        started_at: string;
        duration_ms: number | null;
        tool_calls: number;
        cost_usd: number;
      }[];
      if (runs.length === 0) {
        console.log(`No runs found for agent "${agentName}".`);
        return;
      }
      for (const r of runs) {
        const shortId = r.id.slice(0, 8);
        const duration = r.duration_ms != null ? formatDuration(r.duration_ms) : "-";
        const cost = `$${r.cost_usd.toFixed(3)}`;
        console.log(
          `${shortId}  ${r.started_at}  ${r.status}  ${duration}  ${r.tool_calls} tools  ${cost}`,
        );
      }
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

program
  .command("trace <run-id>")
  .description("Show detailed trace for a run")
  .action(async (runId: string) => {
    try {
      const res = await fetch(`${BASE_URL}/runs/${encodeURIComponent(runId)}`);
      if (!res.ok) {
        const body = (await res.json()) as { error: string };
        console.error(`Error: ${body.error}`);
        process.exitCode = 1;
        return;
      }
      const run = (await res.json()) as {
        id: string;
        agent_name: string;
        started_at: string;
        duration_ms: number | null;
        cost_usd: number;
        events: { type: string; data: Record<string, unknown> | null }[];
      };

      console.log(
        `Run #${run.id.slice(0, 8)} — ${run.agent_name} — ${run.started_at}`,
      );

      const events = run.events ?? [];
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const prefix = i === events.length - 1 ? "└─" : "├─";
        const d = e.data ?? {};

        if (e.type === "llm_call") {
          const model = stripModelDate(String(d.model ?? ""));
          const inTok = fmtNumber(Number(d.input_tokens ?? 0));
          const outTok = fmtNumber(Number(d.output_tokens ?? 0));
          const cost = costFromTokens(Number(d.input_tokens ?? 0), Number(d.output_tokens ?? 0));
          console.log(`${prefix} LLM call: ${model} (${inTok} in, ${outTok} out, $${cost})`);
        } else if (e.type === "tool_call") {
          const dur = formatDuration(Number(d.duration_ms ?? 0));
          const errFlag = d.is_error ? " [error]" : "";
          console.log(`${prefix} Tool call: ${d.tool} (${dur})${errFlag}`);
        } else if (e.type === "error") {
          console.log(`${prefix} Error: ${d.message}`);
        }
      }

      const totalDur = run.duration_ms != null ? formatDuration(run.duration_ms) : "-";
      console.log(`└─ Run complete — ${totalDur} — $${run.cost_usd.toFixed(3)}`);
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

program
  .command("costs")
  .description("Show cost summary across all agents")
  .action(async () => {
    try {
      const agentsRes = await fetch(`${BASE_URL}/agents`);
      const agentsList = (await agentsRes.json()) as { name: string }[];
      if (agentsList.length === 0) {
        console.log("No agents registered.");
        return;
      }

      console.log("Agent\tRuns\tInput Tokens\tOutput Tokens\tCost");
      for (const a of agentsList) {
        const runsRes = await fetch(
          `${BASE_URL}/agents/${encodeURIComponent(a.name)}/runs?limit=10000`,
        );
        const runs = (await runsRes.json()) as {
          total_input_tokens: number;
          total_output_tokens: number;
          cost_usd: number;
        }[];
        const totalIn = runs.reduce((s, r) => s + r.total_input_tokens, 0);
        const totalOut = runs.reduce((s, r) => s + r.total_output_tokens, 0);
        const totalCost = runs.reduce((s, r) => s + r.cost_usd, 0);
        console.log(
          `${a.name}\t${runs.length}\t${fmtNumber(totalIn)}\t${fmtNumber(totalOut)}\t$${totalCost.toFixed(3)}`,
        );
      }
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNextRun(iso: string | null): string {
  if (!iso) return "-";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const days = Math.floor(hr / 24);
  return `in ${days}d`;
}

function stripModelDate(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

function fmtNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function costFromTokens(inputTokens: number, outputTokens: number): string {
  // Approximate — matches the hardcoded pricing in traces.ts for known models
  const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  return cost.toFixed(3);
}

const agents = program
  .command("agents")
  .description("Manage agents");

agents
  .command("list")
  .description("List registered agents")
  .action(async () => {
    try {
      const res = await fetch(`${BASE_URL}/agents`);
      const data = (await res.json()) as { name: string; model: string; description: string | null; next_run: string | null }[];
      if (data.length === 0) {
        console.log("No agents registered.");
        return;
      }
      console.log("Name\tModel\tNext Run\tDescription");
      for (const a of data) {
        const nextRun = formatNextRun(a.next_run);
        console.log(`${a.name}\t${a.model}\t${nextRun}\t${a.description ?? ""}`);
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
      const data = (await res.json()) as { name: string; serverName: string; source?: string; description?: string }[];
      if (data.length === 0) {
        console.log("No tools available.");
        return;
      }
      console.log("Tool\tServer\tSource\tDescription");
      for (const t of data) {
        console.log(`${t.name}\t${t.serverName}\t${t.source ?? ""}\t${t.description ?? ""}`);
      }
    } catch {
      console.error("Failed to reach daemon. Is the daemon running?");
      process.exitCode = 1;
    }
  });

program.parse();
