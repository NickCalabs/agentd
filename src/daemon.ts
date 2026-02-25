import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PID_FILE, DEFAULT_PORT, DEFAULT_HOST, ensureAgentdDir } from "./config.ts";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
}

export async function start(): Promise<void> {
  ensureAgentdDir();

  const existingPid = readPid();
  if (existingPid !== null) {
    if (isProcessAlive(existingPid)) {
      console.log(`agentd is already running (pid ${existingPid})`);
      return;
    }
    // Stale PID file — clean up
    unlinkSync(PID_FILE);
    console.log(`Cleaned up stale PID file (pid ${existingPid})`);
  }

  const serverPath = resolve(import.meta.dirname!, "server.ts");
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", serverPath],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    },
  );

  child.unref();

  const pid = child.pid!;
  writeFileSync(PID_FILE, String(pid), "utf-8");
  console.log(`agentd started (pid ${pid})`);
}

export async function stop(): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    console.log("agentd is not running (no PID file)");
    return;
  }

  if (!isProcessAlive(pid)) {
    unlinkSync(PID_FILE);
    console.log("agentd is not running (stale PID file cleaned up)");
    return;
  }

  process.kill(pid, "SIGTERM");
  unlinkSync(PID_FILE);
  console.log(`agentd stopped (pid ${pid})`);
}

export async function status(): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    console.log("agentd is stopped (no PID file)");
    return;
  }

  if (!isProcessAlive(pid)) {
    unlinkSync(PID_FILE);
    console.log("agentd is stopped (stale PID file cleaned up)");
    return;
  }

  // Process is alive — try /health
  const url = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`;
  try {
    const res = await fetch(url);
    const body = (await res.json()) as { status: string; version: string; uptime: number };
    console.log(`agentd is running`);
    console.log(`  pid:    ${pid}`);
    console.log(`  port:   ${DEFAULT_PORT}`);
    console.log(`  uptime: ${body.uptime}s`);
  } catch {
    console.log(`agentd process is running (pid ${pid}) but /health is not responding`);
  }
}
