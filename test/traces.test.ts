import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_PORT, DEFAULT_HOST } from "../src/config.ts";

const CLI = [process.execPath, "--experimental-strip-types", "src/index.ts"];
const BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

function run(...args: string[]): string {
  return execFileSync(CLI[0], [...CLI.slice(1), ...args], {
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();
}

async function waitForHealthy(retries = 30, interval = 200): Promise<boolean> {
  const url = `${BASE_URL}/health`;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("trace logging", () => {
  const agentDir = join(tmpdir(), "agentd-test-traces");
  const agentPath = join(agentDir, "test-trace-agent.yaml");
  let runId: string;

  afterAll(() => {
    try {
      run("stop");
    } catch {
      // ignore
    }
    try {
      unlinkSync(agentPath);
    } catch {
      // ignore
    }
  });

  it("records runs with token counts and cost", async () => {
    // Start daemon
    run("start");
    const healthy = await waitForHealthy();
    expect(healthy).toBe(true);

    // Create a test agent
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      agentPath,
      `name: test-trace-agent
model: claude-sonnet-4-20250514
prompt: You are a helpful assistant. Use tools to answer the user's question. Be concise.
tools:
  - filesystem
`,
    );

    // Register agent
    const addRes = await fetch(`${BASE_URL}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yamlPath: agentPath }),
    });
    expect(addRes.status).toBe(201);

    // Run agent
    const runRes = await fetch(`${BASE_URL}/agents/test-trace-agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: "List the files in the current directory and tell me how many there are",
      }),
    });
    expect(runRes.status).toBe(200);

    const result = (await runRes.json()) as {
      runId: string;
      toolCalls: number;
      costUsd: number;
    };
    runId = result.runId;
    expect(runId).toBeDefined();
    expect(result.toolCalls).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);

    // Check runs endpoint
    const runsRes = await fetch(`${BASE_URL}/agents/test-trace-agent/runs`);
    const runs = (await runsRes.json()) as {
      id: string;
      total_input_tokens: number;
      total_output_tokens: number;
      cost_usd: number;
    }[];
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].total_input_tokens).toBeGreaterThan(0);
    expect(runs[0].total_output_tokens).toBeGreaterThan(0);
    expect(runs[0].cost_usd).toBeGreaterThan(0);
  }, 30_000);

  it("records events for a run", async () => {
    expect(runId).toBeDefined();
    const res = await fetch(`${BASE_URL}/runs/${runId}`);
    expect(res.status).toBe(200);

    const run = (await res.json()) as {
      events: { type: string; data: Record<string, unknown> }[];
    };
    expect(run.events.length).toBeGreaterThan(0);

    const llmEvents = run.events.filter((e) => e.type === "llm_call");
    const toolEvents = run.events.filter((e) => e.type === "tool_call");
    expect(llmEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);

    // LLM event should have token counts
    expect(llmEvents[0].data.input_tokens).toBeGreaterThan(0);
    expect(llmEvents[0].data.output_tokens).toBeGreaterThan(0);
  }, 30_000);

  it("CLI logs shows run summary", () => {
    const output = run("logs", "test-trace-agent");
    expect(output).toContain(runId.slice(0, 8));
    expect(output).toContain("$");
  }, 10_000);

  it("CLI trace shows event tree", () => {
    const output = run("trace", runId);
    expect(output).toContain("LLM call");
    expect(output).toContain("Tool call");
  }, 10_000);
});
