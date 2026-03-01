import { createRequire } from "node:module";
import { getDb } from "./state.ts";
import { listAgents } from "./agents.ts";

const require = createRequire(import.meta.url);
const cron = require("node-cron") as typeof import("node-cron");
const cronParser = require("cron-parser") as typeof import("cron-parser");

import type { ScheduledTask } from "node-cron";

const scheduled = new Map<string, ScheduledTask[]>();

export function parseCronTriggers(triggers: string[]): string[] {
  return triggers
    .filter((t) => t.startsWith("cron:"))
    .map((t) => t.slice(5));
}

export function computeNextRun(triggers: string[]): string | null {
  const exprs = parseCronTriggers(triggers);
  if (exprs.length === 0) return null;

  let earliest: Date | null = null;
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

export function updateNextRun(agentName: string, triggers: string[]): void {
  const nextRun = computeNextRun(triggers);
  const db = getDb();
  db.prepare("UPDATE agents SET next_run = ? WHERE name = ?").run(nextRun, agentName);
}

export function scheduleAgent(agentName: string, triggers: string[]): void {
  // Clean up any existing tasks first
  unscheduleAgent(agentName);

  const exprs = parseCronTriggers(triggers);
  if (exprs.length === 0) return;

  const tasks: ScheduledTask[] = [];

  for (const expr of exprs) {
    const task = cron.schedule(expr, async () => {
      try {
        console.log(`Cron fired for agent "${agentName}" (cron: ${expr})`);
        const { createRun } = await import("./traces.ts");
        const { runAgent } = await import("./runner.ts");
        const runId = createRun(agentName);
        await runAgent(agentName, runId, `Scheduled run (cron: ${expr})`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Scheduled run failed for "${agentName}": ${msg}`);
      } finally {
        updateNextRun(agentName, triggers);
      }
    });
    tasks.push(task);
  }

  scheduled.set(agentName, tasks);
  updateNextRun(agentName, triggers);
}

export function unscheduleAgent(agentName: string): void {
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

export function initScheduler(): void {
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

export function stopScheduler(): void {
  for (const [, tasks] of scheduled) {
    for (const task of tasks) {
      task.stop();
    }
  }
  scheduled.clear();
}
