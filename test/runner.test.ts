import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
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

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("agent runner", () => {
  afterAll(() => {
    try {
      run("stop");
    } catch {
      // ignore
    }
  });

  it("runs an agent with tools and produces output", async () => {
    // Start daemon
    run("start");
    const healthy = await waitForHealthy();
    expect(healthy).toBe(true);

    // Create a test agent YAML
    const agentDir = join(tmpdir(), "agentd-test-runner");
    mkdirSync(agentDir, { recursive: true });
    const agentPath = join(agentDir, "test-runner-agent.yaml");
    writeFileSync(
      agentPath,
      `name: test-runner-agent
model: claude-sonnet-4-20250514
prompt: You are a helpful assistant. Use tools to answer the user's question. Be concise.
tools:
  - filesystem
`,
    );

    try {
      // Register agent
      const addRes = await fetch(`${BASE_URL}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yamlPath: agentPath }),
      });
      expect(addRes.status).toBe(201);

      // Run agent
      const runRes = await fetch(`${BASE_URL}/agents/test-runner-agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: "List the files in my home directory and tell me how many there are",
        }),
      });
      expect(runRes.status).toBe(200);

      const result = (await runRes.json()) as {
        agentName: string;
        output: string;
        toolCalls: number;
        durationMs: number;
      };
      expect(result.agentName).toBe("test-runner-agent");
      expect(result.output.length).toBeGreaterThan(0);
      expect(result.toolCalls).toBeGreaterThan(0);
      expect(result.output).toMatch(/\d/);
    } finally {
      try {
        unlinkSync(agentPath);
      } catch {
        // ignore
      }
    }
  }, 30_000);

  it("returns 404 for nonexistent agent", async () => {
    const res = await fetch(`${BASE_URL}/agents/nonexistent-agent-xyz/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
