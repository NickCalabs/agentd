import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_PORT, DEFAULT_HOST } from "../src/config.ts";

const BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const CLI = [process.execPath, "--experimental-strip-types", "src/index.ts"];
const TOOLS_DIR = join(homedir(), ".agentd", "tools");

function run(...args: string[]): string {
  try {
    return execFileSync(CLI[0], [...CLI.slice(1), ...args], {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    return ((e.stdout ?? "") + (e.stderr ?? "")).trim();
  }
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

async function waitForTools(retries = 60, interval = 1000): Promise<boolean> {
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

function cleanup(name: string): void {
  const configPath = join(TOOLS_DIR, `${name}.json`);
  if (existsSync(configPath)) {
    try { unlinkSync(configPath); } catch { /* ignore */ }
  }
}

describe("tools add/remove management", () => {
  afterAll(() => {
    cleanup("test-add");
    try { run("stop"); } catch { /* ignore */ }
  });

  it("manages MCP tool servers via API and CLI", { timeout: 120_000 }, async () => {
    // 1. Start daemon and wait for healthy
    run("start");
    expect(await waitForHealthy()).toBe(true);
    expect(await waitForTools()).toBe(true);

    // 2. POST /tools/servers — register using local fixture
    const fsServerPath = join(process.cwd(), "node_modules", "@modelcontextprotocol", "server-filesystem", "dist", "index.js");
    const addRes = await fetch(`${BASE_URL}/tools/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-add",
        config: { command: "node", args: [fsServerPath, "/tmp"] },
        confirmed: true,
      }),
    });
    expect(addRes.status).toBe(201);
    const addBody = (await addRes.json()) as { name: string; tools: number; toolNames: string[] };
    expect(addBody.name).toBe("test-add");
    expect(addBody.tools).toBeGreaterThan(0);
    expect(addBody.toolNames.length).toBeGreaterThan(0);

    // 3. Verify GET /tools includes test-add tools
    const toolsRes = await fetch(`${BASE_URL}/tools`);
    const tools = (await toolsRes.json()) as { name: string; serverName: string }[];
    expect(tools.some((t) => t.serverName === "test-add")).toBe(true);

    // 4. POST /tools/servers without confirmed — should fail
    const noConfirmRes = await fetch(`${BASE_URL}/tools/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad", config: { command: "echo" } }),
    });
    expect(noConfirmRes.status).toBe(400);

    // 5. Write config file, then tools remove — verify cleanup
    mkdirSync(TOOLS_DIR, { recursive: true });
    const configPath = join(TOOLS_DIR, "test-add.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "test-add": { command: "node", args: [fsServerPath, "/tmp"] } } }), "utf-8");
    expect(existsSync(configPath)).toBe(true);

    const removeOut = run("tools", "remove", "test-add");
    expect(removeOut).toContain("Disconnected");
    expect(existsSync(configPath)).toBe(false);

    // 6. Verify server is gone from GET /tools
    const toolsAfterRes = await fetch(`${BASE_URL}/tools`);
    const toolsAfter = (await toolsAfterRes.json()) as { serverName: string }[];
    expect(toolsAfter.some((t) => t.serverName === "test-add")).toBe(false);

    // 7. Test tools list output contains grouped format
    const listOut = run("tools", "list");
    expect(listOut).toContain("tools from");
    expect(listOut).toContain("filesystem");

    // 8. Test status output contains compact format
    const statusOut = run("status");
    expect(statusOut).toMatch(/running \(pid \d+\)/);
    expect(statusOut).toContain("tools:");
    expect(statusOut).toContain("agents:");

    // 9. Stop daemon
    const stopOut = run("stop");
    expect(stopOut).toMatch(/stopped/);
  });
});
