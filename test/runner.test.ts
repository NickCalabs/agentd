import { describe, it, expect, afterAll, beforeAll } from "vitest";
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

async function waitForRunStatus(
  runId: string,
  targetStatuses: string[],
  timeoutMs = 30_000,
  interval = 500,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/runs/${runId}`);
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      if (targetStatuses.includes(data.status as string)) return data;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

describe("agent runner (async)", () => {
  afterAll(() => {
    try {
      run("stop");
    } catch {
      // ignore
    }
  });

  beforeAll(async () => {
    run("start");
    const healthy = await waitForHealthy();
    expect(healthy).toBe(true);
  });

  it("POST /agents/:name/run returns 202 with a runId immediately", async () => {
    const agentDir = join(tmpdir(), "agentd-test-async-run");
    mkdirSync(agentDir, { recursive: true });
    const agentPath = join(agentDir, "async-test-agent.yaml");
    writeFileSync(
      agentPath,
      `name: async-test-agent
model: claude-sonnet-4-20250514
prompt: Say hello.
tools: []
`,
    );

    try {
      // Clean up from prior runs
      await fetch(`${BASE_URL}/agents/async-test-agent`, { method: "DELETE" });

      const addRes = await fetch(`${BASE_URL}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yamlPath: agentPath }),
      });
      expect(addRes.status).toBe(201);

      const start = Date.now();
      const runRes = await fetch(`${BASE_URL}/agents/async-test-agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const elapsed = Date.now() - start;

      expect(runRes.status).toBe(202);
      const body = (await runRes.json()) as { runId: string };
      expect(body.runId).toBeDefined();
      expect(typeof body.runId).toBe("string");
      expect(body.runId.length).toBeGreaterThan(0);

      // Should return quickly (well under 5 seconds, not waiting for LLM)
      expect(elapsed).toBeLessThan(5000);
    } finally {
      try {
        unlinkSync(agentPath);
      } catch {
        // ignore
      }
    }
  });

  it("returns 404 for nonexistent agent", async () => {
    const res = await fetch(`${BASE_URL}/agents/nonexistent-agent-xyz/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("run with invalid model fails with clear error in trace, not a daemon crash", async () => {
    const agentDir = join(tmpdir(), "agentd-test-bad-model");
    mkdirSync(agentDir, { recursive: true });
    const agentPath = join(agentDir, "badmodel-agent.yaml");
    writeFileSync(
      agentPath,
      `name: badmodel-agent
model: claude-nonexistent-xyz
prompt: Say hello.
tools: []
`,
    );

    try {
      // Clean up from prior runs
      await fetch(`${BASE_URL}/agents/badmodel-agent`, { method: "DELETE" });

      const addRes = await fetch(`${BASE_URL}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yamlPath: agentPath }),
      });
      expect(addRes.status).toBe(201);

      // Trigger a run — the daemon should stay healthy even if the run fails
      const runRes = await fetch(`${BASE_URL}/agents/badmodel-agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(runRes.status).toBe(202);
      const { runId } = (await runRes.json()) as { runId: string };

      // Wait for the run to finish (it should fail, not hang)
      const completedRun = await waitForRunStatus(runId, ["error", "completed"], 15_000);
      expect(completedRun).not.toBeNull();
      expect(completedRun!.status).toBe("error");
      expect(typeof completedRun!.error).toBe("string");

      // Daemon should still be healthy after the failed run
      const healthRes = await fetch(`${BASE_URL}/health`);
      expect(healthRes.status).toBe(200);
    } finally {
      try {
        unlinkSync(agentPath);
      } catch {
        // ignore
      }
    }
  }, 20_000);
});
