import { createRequire } from "node:module";
import { getDb } from "./state.js";
import { listAgents } from "./agents.js";
const require = createRequire(import.meta.url);
const cron = require("node-cron");
const cronParser = require("cron-parser");
const scheduled = new Map();
export function parseCronTriggers(triggers) {
    return triggers
        .filter((t) => t.startsWith("cron:"))
        .map((t) => t.slice(5));
}
export function computeNextRun(triggers) {
    const exprs = parseCronTriggers(triggers);
    if (exprs.length === 0)
        return null;
    let earliest = null;
    const now = new Date();
    for (const expr of exprs) {
        const parsed = cronParser.CronExpressionParser.parse(expr);
        const next = parsed.next().toDate();
        if (!earliest || next < earliest) {
            earliest = next;
        }
    }
    return earliest ? earliest.toISOString() : null;
}
export function updateNextRun(agentName, triggers) {
    const nextRun = computeNextRun(triggers);
    const db = getDb();
    db.prepare("UPDATE agents SET next_run = ? WHERE name = ?").run(nextRun, agentName);
}
export function scheduleAgent(agentName, triggers) {
    // Clean up any existing tasks first
    unscheduleAgent(agentName);
    const exprs = parseCronTriggers(triggers);
    if (exprs.length === 0)
        return;
    const tasks = [];
    for (const expr of exprs) {
        const task = cron.schedule(expr, async () => {
            try {
                console.log(`Cron fired for agent "${agentName}" (cron: ${expr})`);
                const { createRun } = await import("./traces.js");
                const { runAgent } = await import("./runner.js");
                const runId = createRun(agentName);
                await runAgent(agentName, runId, `Scheduled run (cron: ${expr})`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`Scheduled run failed for "${agentName}": ${msg}`);
            }
            finally {
                updateNextRun(agentName, triggers);
            }
        });
        tasks.push(task);
    }
    scheduled.set(agentName, tasks);
    updateNextRun(agentName, triggers);
}
export function unscheduleAgent(agentName) {
    const tasks = scheduled.get(agentName);
    if (tasks) {
        for (const task of tasks) {
            task.stop();
        }
        scheduled.delete(agentName);
    }
    const db = getDb();
    db.prepare("UPDATE agents SET next_run = NULL WHERE name = ?").run(agentName);
}
export function initScheduler() {
    const agents = listAgents();
    for (const agent of agents) {
        const exprs = parseCronTriggers(agent.triggers);
        if (exprs.length > 0) {
            scheduleAgent(agent.name, agent.triggers);
        }
    }
    const count = scheduled.size;
    if (count > 0) {
        console.log(`Scheduler: ${count} agent(s) with cron triggers`);
    }
}
export function stopScheduler() {
    for (const [, tasks] of scheduled) {
        for (const task of tasks) {
            task.stop();
        }
    }
    scheduled.clear();
}
