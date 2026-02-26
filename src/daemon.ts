import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { PID_FILE, DEFAULT_PORT, DEFAULT_HOST, AGENTD_DIR, ensureAgentdDir } from "./config.ts";

export const LOG_FILE = join(AGENTD_DIR, "daemon.log");

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

  // Check if something is already listening on the port (covers the case where
  // the PID file was deleted but the daemon is still running)
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`);
    if (res.ok) {
      console.log(`agentd is already running on port ${DEFAULT_PORT} (PID file was missing)`);
      return;
    }
  } catch {
    // Nothing listening — good, we can proceed
  }

  // When running from dist/, the file is server.js; from src/ it's server.ts
  const dir = import.meta.dirname!;
  const serverPath = resolve(dir, existsSync(resolve(dir, "server.js")) ? "server.js" : "server.ts");
  const args = serverPath.endsWith(".ts")
    ? ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", serverPath]
    : [serverPath];
  const logFd = openSync(LOG_FILE, "w");
  const child = spawn(
    process.execPath,
    args,
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    },
  );

  child.unref();
  closeSync(logFd);

  const pid = child.pid!;
  writeFileSync(PID_FILE, String(pid), "utf-8");

  // Wait for the daemon to become healthy or die trying
  const healthy = await waitForHealthy(pid);
  if (!healthy) {
    if (!isProcessAlive(pid)) {
      // Process actually crashed — clean up PID file and report
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      const log = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8").trim() : "";
      const lastLines = log.split("\n").slice(-5).join("\n");
      console.error(`agentd failed to start (pid ${pid})`);
      if (lastLines) {
        console.error(`Log output (${LOG_FILE}):\n${lastLines}`);
      }
      process.exitCode = 1;
      return;
    }
    // Process is alive but health endpoint not ready yet — still starting up
    console.log(`agentd started (pid ${pid}), still initializing...`);
    return;
  }

  console.log(`agentd started (pid ${pid})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealthy(pid: number, timeoutMs = 10_000, intervalMs = 200): Promise<boolean> {
  const url = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return false;
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await sleep(intervalMs);
  }
  return false;
}

async function waitForExit(pid: number, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(intervalMs);
  }
  return !isProcessAlive(pid);
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

  if (await waitForExit(pid, 3000)) {
    unlinkSync(PID_FILE);
    console.log(`agentd stopped (pid ${pid})`);
    return;
  }

  // Still alive after 3s — force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead between the check and the kill
  }
  await sleep(500);
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  console.log(`agentd killed (pid ${pid})`);
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
  const base = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  try {
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as { status: string; version: string; uptime: number };
    console.log(`agentd is running`);
    console.log(`  pid:    ${pid}`);
    console.log(`  port:   ${DEFAULT_PORT}`);
    console.log(`  uptime: ${body.uptime}s`);

    // Show discovered tools grouped by server
    try {
      const toolsRes = await fetch(`${base}/tools`);
      const tools = (await toolsRes.json()) as { name: string; serverName: string; source?: string }[];
      if (tools.length > 0) {
        // Group by server
        const byServer = new Map<string, { source: string; count: number }>();
        for (const t of tools) {
          const existing = byServer.get(t.serverName);
          if (existing) {
            existing.count++;
          } else {
            byServer.set(t.serverName, { source: t.source ?? "", count: 1 });
          }
        }
        console.log(`  tools:  ${byServer.size} sources, ${tools.length} tools`);
        for (const [server, info] of byServer) {
          const src = info.source ? ` (${info.source})` : "";
          const pad = " ".repeat(Math.max(0, 12 - server.length));
          console.log(`          ${server}${pad}${info.count} tools${src}`);
        }
      } else {
        console.log(`  tools:  none`);
      }
    } catch {
      // Tools endpoint unavailable — not critical
    }
  } catch {
    console.log(`agentd process is running (pid ${pid}) but /health is not responding`);
  }
}
