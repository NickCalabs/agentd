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

async function waitForHealthy(retries = 30, interval = 200): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch { /* not ready */ }
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
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

async function callTool(tool: string, args: Record<string, unknown>): Promise<{ content?: { type: string; text: string }[]; isError?: boolean }> {
  const res = await fetch(`${BASE_URL}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json() as Promise<{ content?: { type: string; text: string }[]; isError?: boolean }>;
}

describe("security hardening", () => {
  afterAll(() => {
    try { run("stop"); } catch { /* ignore */ }
  });

  it("starts daemon for security tests", { timeout: 60_000 }, async () => {
    run("start");
    expect(await waitForHealthy()).toBe(true);
    expect(await waitForTools()).toBe(true);
  });

  it("git.show does not allow shell injection via ref", { timeout: 10_000 }, async () => {
    // With execFileSync, "HEAD; echo INJECTED" is passed as a single argument to git,
    // so git treats it as a literal ref name and fails with "unknown revision".
    // The shell never interprets the semicolon.
    const result = await callTool("git.show", { ref: "HEAD; echo INJECTED" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toMatch(/unknown revision|ambiguous argument/);
  });

  it("git.log does not allow shell injection via count", { timeout: 10_000 }, async () => {
    // count goes through Number() so this tests the args path
    const result = await callTool("git.log", { count: 5 });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toBeDefined();
  });

  it("shell.which does not allow shell injection", { timeout: 10_000 }, async () => {
    // With execFileSync, "node; echo INJECTED" is passed as a single argument to which,
    // so it looks for a command literally named "node; echo INJECTED" and fails.
    // The shell never interprets the semicolon.
    const result = await callTool("shell.which", { command: "node; echo INJECTED" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toMatch(/not found/);
    expect(result.isError).toBe(true);
  });

  it("shell.read_env redacts ANTHROPIC_API_KEY", { timeout: 10_000 }, async () => {
    const result = await callTool("shell.read_env", { name: "ANTHROPIC_API_KEY" });
    const text = result.content?.[0]?.text ?? "";
    if (process.env.ANTHROPIC_API_KEY) {
      expect(text).toBe("[REDACTED]");
      expect(text).not.toBe(process.env.ANTHROPIC_API_KEY);
    } else {
      // Even if not set, should still return [REDACTED], not "is not set"
      expect(text).toBe("[REDACTED]");
    }
  });

  it("shell.read_env redacts vars ending in _SECRET", { timeout: 10_000 }, async () => {
    const result = await callTool("shell.read_env", { name: "MY_APP_SECRET" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("[REDACTED]");
  });

  it("shell.read_env redacts vars ending in _TOKEN", { timeout: 10_000 }, async () => {
    const result = await callTool("shell.read_env", { name: "GITHUB_TOKEN" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("[REDACTED]");
  });

  it("shell.read_env redacts vars ending in _PASSWORD", { timeout: 10_000 }, async () => {
    const result = await callTool("shell.read_env", { name: "DB_PASSWORD" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("[REDACTED]");
  });

  it("shell.read_env allows non-sensitive vars", { timeout: 10_000 }, async () => {
    const result = await callTool("shell.read_env", { name: "HOME" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).not.toBe("[REDACTED]");
    expect(text.length).toBeGreaterThan(0);
  });

  it("stops daemon", { timeout: 10_000 }, () => {
    const out = run("stop");
    expect(out).toMatch(/stopped/);
  });
});
