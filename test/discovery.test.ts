import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

async function waitForHealthy(retries = 30, interval = 200): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

async function waitForTools(retries = 60, interval = 1000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/tools`);
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

const AGENTD_TOOLS_DIR = join(homedir(), ".agentd", "tools");
const FIXTURE_SRC = join(import.meta.dirname, "fixtures", "discovery-tools.json");
const FIXTURE_DEST = join(AGENTD_TOOLS_DIR, "discovery-tools.json");

describe("MCP auto-discovery", () => {
  afterAll(() => {
    try {
      run("stop");
    } catch {
      // ignore
    }
    // Clean up the fixture we copied
    if (existsSync(FIXTURE_DEST)) {
      rmSync(FIXTURE_DEST);
    }
  });

  it("built-in tools show source 'built-in'", { timeout: 60_000 }, async () => {
    run("start");
    expect(await waitForHealthy()).toBe(true);
    expect(await waitForTools()).toBe(true);

    const res = await fetch(`${BASE_URL}/tools`);
    expect(res.status).toBe(200);
    const tools = (await res.json()) as { name: string; source: string }[];
    const fsTool = tools.find((t) => t.name === "filesystem.list_directory");
    expect(fsTool).toBeDefined();
    expect(fsTool!.source).toBe("built-in");

    run("stop");
  });

  it("manually placed JSON is discovered with source 'agentd-tools'", { timeout: 60_000 }, async () => {
    // Copy fixture into ~/.agentd/tools/
    mkdirSync(AGENTD_TOOLS_DIR, { recursive: true });
    copyFileSync(FIXTURE_SRC, FIXTURE_DEST);

    run("start");
    expect(await waitForHealthy()).toBe(true);

    // Wait for test-fs tools to appear
    let tools: { name: string; source: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${BASE_URL}/tools`);
      if (res.ok) {
        tools = (await res.json()) as { name: string; source: string }[];
        if (tools.some((t) => t.name.startsWith("test-fs."))) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const testFsTools = tools.filter((t) => t.name.startsWith("test-fs."));
    expect(testFsTools.length).toBeGreaterThan(0);
    expect(testFsTools.every((t) => t.source === "agentd-tools")).toBe(true);
  });
});
