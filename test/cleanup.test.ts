import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { PID_FILE, DEFAULT_PORT, DEFAULT_HOST } from "../src/config.ts";

const CLI = [process.execPath, "--experimental-strip-types", "src/index.ts"];

function run(...args: string[]): string {
  return execFileSync(CLI[0], [...CLI.slice(1), ...args], {
    encoding: "utf-8",
    timeout: 15_000,
  }).trim();
}

async function waitForHealthy(retries = 30, interval = 200): Promise<boolean> {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("process cleanup", () => {
  afterAll(() => {
    try {
      run("stop");
    } catch {
      // ignore
    }
  });

  it("stop sends SIGTERM and process exits cleanly", { timeout: 20_000 }, async () => {
    run("start");
    expect(await waitForHealthy()).toBe(true);

    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    expect(isProcessAlive(pid)).toBe(true);

    const stopOut = run("stop");
    expect(stopOut).toMatch(/agentd stopped/);
    // Should NOT say "killed" — the process exited gracefully via SIGTERM
    expect(stopOut).not.toMatch(/killed/);

    // Process should be dead
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("PID file is removed after stop", () => {
    // After the previous test's stop, PID file must be gone
    expect(existsSync(PID_FILE)).toBe(false);
  });

  it("status reports not running after stop", () => {
    const statusOut = run("status");
    expect(statusOut).toMatch(/stopped/);
  });
});
