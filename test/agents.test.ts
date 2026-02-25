import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DEFAULT_PORT, DEFAULT_HOST } from "../src/config.ts";

const CLI = [process.execPath, "--experimental-strip-types", "src/index.ts"];
const FIXTURE = resolve("test/fixtures/test-agent.yaml");

function run(...args: string[]): string {
  try {
    return execFileSync(CLI[0], [...CLI.slice(1), ...args], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    // Return combined output so tests can assert on error messages
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

describe("agent registry", () => {
  afterAll(() => {
    try {
      run("stop");
    } catch {
      // ignore
    }
  });

  it("full agent lifecycle with persistence across restart", { timeout: 30_000 }, async () => {
    // 1. Start daemon
    run("start");
    expect(await waitForHealthy()).toBe(true);

    // Clean up any leftover test agent from prior runs
    await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/test-echo`, { method: "DELETE" });

    // 2. Add agent
    const addOut = run("agents", "add", FIXTURE);
    expect(addOut).toMatch(/registered/);

    // 3. List agents
    const listOut = run("agents", "list");
    expect(listOut).toContain("test-echo");

    // 4. GET /agents/test-echo — verify full shape
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/agents/test-echo`);
    expect(res.status).toBe(200);
    const agent = (await res.json()) as Record<string, unknown>;
    expect(agent.name).toBe("test-echo");
    expect(agent.model).toBe("claude-sonnet-4-20250514");
    expect(agent.prompt).toBe("You are a test agent. Echo back whatever the user says.");
    expect(agent.tools).toEqual(["shell"]);
    expect(agent.triggers).toEqual(["manual"]);

    // 5. Duplicate add should fail
    const dupOut = run("agents", "add", FIXTURE);
    expect(dupOut).toMatch(/already exists/i);

    // 6. Stop, wait, restart — agent should persist
    run("stop");
    await new Promise((r) => setTimeout(r, 500));
    run("start");
    expect(await waitForHealthy()).toBe(true);

    const listAfterRestart = run("agents", "list");
    expect(listAfterRestart).toContain("test-echo");

    // 7. Remove agent
    const removeOut = run("agents", "remove", "test-echo");
    expect(removeOut).toMatch(/removed/);

    // 8. List should be empty
    const listEmpty = run("agents", "list");
    expect(listEmpty).toMatch(/No agents registered/);

    // 9. Remove nonexistent should error
    const removeNone = run("agents", "remove", "nonexistent");
    expect(removeNone).toMatch(/not found/i);

    // 10. Stop
    const stopOut = run("stop");
    expect(stopOut).toMatch(/stopped/);
  });
});
