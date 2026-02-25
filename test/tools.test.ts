import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { DEFAULT_PORT, DEFAULT_HOST } from "../src/config.ts";

const BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const CLI = [process.execPath, "--experimental-strip-types", "src/index.ts"];

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

async function waitForTools(
  retries = 60,
  interval = 1000,
): Promise<boolean> {
  const url = `${BASE_URL}/tools`;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as unknown[];
        if (data.length > 0) return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

describe("tool registry", () => {
  afterAll(() => {
    try {
      run("stop");
    } catch {
      // ignore
    }
  });

  it("discovers MCP tools and exposes them via API and CLI", { timeout: 60_000 }, async () => {
    // 1. Start daemon and wait for healthy
    run("start");
    expect(await waitForHealthy()).toBe(true);

    // 2. Wait for MCP tools to be discovered
    expect(await waitForTools()).toBe(true);

    // 3. GET /tools — verify filesystem tools exist
    const toolsRes = await fetch(`${BASE_URL}/tools`);
    expect(toolsRes.status).toBe(200);
    const tools = (await toolsRes.json()) as { name: string; serverName: string }[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.name.startsWith("filesystem."))).toBe(true);
    expect(tools.some((t) => t.name === "filesystem.list_directory")).toBe(true);

    // 4. POST /tools/call — call list_directory on /tmp
    const callRes = await fetch(`${BASE_URL}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "filesystem.list_directory", args: { path: "/tmp" } }),
    });
    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as { content: unknown[] };
    expect(callBody.content).toBeDefined();

    // 5. POST /tools/call — nonexistent tool returns 400
    const notFoundRes = await fetch(`${BASE_URL}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "filesystem.nonexistent_tool", args: {} }),
    });
    expect(notFoundRes.status).toBe(400);
    const notFoundBody = (await notFoundRes.json()) as { error: string };
    expect(notFoundBody.error).toMatch(/not found/i);

    // 6. POST /tools/call — missing tool field returns 400
    const missingRes = await fetch(`${BASE_URL}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(missingRes.status).toBe(400);

    // 7. CLI tools list — output contains filesystem.
    const listOut = run("tools", "list");
    expect(listOut).toContain("filesystem.");

    // 8. Stop daemon
    const stopOut = run("stop");
    expect(stopOut).toMatch(/stopped/);
  });
});
