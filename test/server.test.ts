import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PID_FILE, DEFAULT_PORT, DEFAULT_HOST } from "../src/config.ts";

const CLI = [process.execPath, "--experimental-strip-types", "src/index.ts"];

function run(...args: string[]): string {
  return execFileSync(CLI[0], [...CLI.slice(1), ...args], {
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();
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

describe("agentd daemon", () => {
  afterAll(() => {
    // Ensure cleanup even if a test fails
    try {
      run("stop");
    } catch {
      // ignore
    }
  });

  it("starts the daemon, responds to /health, and stops cleanly", async () => {
    // Start
    const startOut = run("start");
    expect(startOut).toMatch(/agentd started/);

    // Wait for server to be healthy
    const healthy = await waitForHealthy();
    expect(healthy).toBe(true);

    // PID file should exist
    expect(existsSync(PID_FILE)).toBe(true);

    // Hit /health
    const res = await fetch(
      `http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      version: "0.1.0",
    });
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);

    // Starting again should detect it's already running
    const startAgainOut = run("start");
    expect(startAgainOut).toMatch(/already running/);

    // Status
    const statusOut = run("status");
    expect(statusOut).toMatch(/running/);
    expect(statusOut).toMatch(/pid \d+/);
    expect(statusOut).toMatch(/port: 4700/);

    // Stop
    const stopOut = run("stop");
    expect(stopOut).toMatch(/agentd stopped/);

    // PID file should be gone
    expect(existsSync(PID_FILE)).toBe(false);

    // Stopping again should be a no-op
    const stopAgainOut = run("stop");
    expect(stopAgainOut).toMatch(/not running/);
  });
});
