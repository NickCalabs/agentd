import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DEFAULT_PORT, DEFAULT_HOST } from "../src/config.ts";

const CLI = [process.execPath, "--experimental-strip-types", "src/index.ts"];
const CRON_FIXTURE = resolve("test/fixtures/cron-agent.yaml");
const MANUAL_FIXTURE = resolve("test/fixtures/manual-only-agent.yaml");

function run(...args: string[]): string {
  try {
    return execFileSync(CLI[0], [...CLI.slice(1), ...args], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    return ((e.stdout ?? "") + (e.stderr ?? "")).trim();
  }
}

async function waitForHealthy(
  retries = 30,
  interval = 200,
): Promise<boolean> {
  const url = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`;
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

describe("cron scheduler", () => {
  afterAll(() => {
    try {
      run("stop");
    } catch {
      // ignore
    }
  });

  it("agent with cron trigger has next_run populated", { timeout: 30_000 }, async () => {
    run("start");
    expect(await waitForHealthy()).toBe(true);

    // Clean up any leftover agents
    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/cron-test-agent`, { method: "DELETE" });

    const addOut = run("agents", "add", CRON_FIXTURE);
    expect(addOut).toMatch(/registered/);

    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/cron-test-agent`);
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { next_run: string | null };
    expect(agent.next_run).toBeTruthy();
    // next_run should be a valid future ISO date
    const nextRunDate = new Date(agent.next_run!);
    expect(nextRunDate.getTime()).toBeGreaterThan(Date.now() - 1000);

    // Cleanup
    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/cron-test-agent`, { method: "DELETE" });
  });

  it("agent without cron triggers has null next_run", { timeout: 30_000 }, async () => {
    expect(await waitForHealthy()).toBe(true);

    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/manual-only-agent`, { method: "DELETE" });

    const addOut = run("agents", "add", MANUAL_FIXTURE);
    expect(addOut).toMatch(/registered/);

    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/manual-only-agent`);
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { next_run: string | null };
    expect(agent.next_run).toBeNull();

    // Cleanup
    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/manual-only-agent`, { method: "DELETE" });
  });

  it("agents list shows next run time for cron agent", { timeout: 30_000 }, async () => {
    expect(await waitForHealthy()).toBe(true);

    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/cron-test-agent`, { method: "DELETE" });
    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/manual-only-agent`, { method: "DELETE" });

    run("agents", "add", CRON_FIXTURE);
    run("agents", "add", MANUAL_FIXTURE);

    const listOut = run("agents", "list");
    // Cron agent should show relative time (e.g. "in 5m", "in 4m", etc.)
    expect(listOut).toMatch(/cron-test-agent.*in \d+/);
    // Manual-only agent should show "-"
    expect(listOut).toMatch(/manual-only-agent.*-/);

    // Cleanup
    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/cron-test-agent`, { method: "DELETE" });
    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/manual-only-agent`, { method: "DELETE" });

    run("stop");
  });
});
