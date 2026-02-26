import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PID_FILE, DEFAULT_PORT, DEFAULT_HOST, ensureAgentdDir } from "./config.js";
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readPid() {
    if (!existsSync(PID_FILE))
        return null;
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
}
export async function start() {
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
    const serverPath = resolve(import.meta.dirname, "server.ts");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning --experimental-strip-types", serverPath], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
    });
    child.unref();
    const pid = child.pid;
    writeFileSync(PID_FILE, String(pid), "utf-8");
    console.log(`agentd started (pid ${pid})`);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function waitForExit(pid, timeoutMs, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid))
            return true;
        await sleep(intervalMs);
    }
    return !isProcessAlive(pid);
}
export async function stop() {
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
    }
    catch {
        // Already dead between the check and the kill
    }
    await sleep(500);
    if (existsSync(PID_FILE))
        unlinkSync(PID_FILE);
    console.log(`agentd killed (pid ${pid})`);
}
export async function status() {
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
        const body = (await res.json());
        console.log(`agentd is running`);
        console.log(`  pid:    ${pid}`);
        console.log(`  port:   ${DEFAULT_PORT}`);
        console.log(`  uptime: ${body.uptime}s`);
        // Show discovered tools grouped by server
        try {
            const toolsRes = await fetch(`${base}/tools`);
            const tools = (await toolsRes.json());
            if (tools.length > 0) {
                // Group by server
                const byServer = new Map();
                for (const t of tools) {
                    const existing = byServer.get(t.serverName);
                    if (existing) {
                        existing.count++;
                    }
                    else {
                        byServer.set(t.serverName, { source: t.source ?? "", count: 1 });
                    }
                }
                console.log(`  tools:  ${byServer.size} sources, ${tools.length} tools`);
                for (const [server, info] of byServer) {
                    const src = info.source ? ` (${info.source})` : "";
                    const pad = " ".repeat(Math.max(0, 12 - server.length));
                    console.log(`          ${server}${pad}${info.count} tools${src}`);
                }
            }
            else {
                console.log(`  tools:  none`);
            }
        }
        catch {
            // Tools endpoint unavailable — not critical
        }
    }
    catch {
        console.log(`agentd process is running (pid ${pid}) but /health is not responding`);
    }
}
