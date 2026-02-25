import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

export const AGENTD_DIR = join(homedir(), ".agentd");
export const PID_FILE = join(AGENTD_DIR, "agentd.pid");
export const CONFIG_FILE = join(AGENTD_DIR, "config.yaml");
export const DEFAULT_PORT = 4700;
export const DEFAULT_HOST = "localhost";

export interface AgentdConfig {
  port: number;
  host: string;
}

export function ensureAgentdDir(): void {
  if (!existsSync(AGENTD_DIR)) {
    mkdirSync(AGENTD_DIR, { recursive: true });
  }
}

export function loadConfig(): AgentdConfig {
  const defaults: AgentdConfig = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
  };

  if (!existsSync(CONFIG_FILE)) {
    return defaults;
  }

  const raw = readFileSync(CONFIG_FILE, "utf-8");
  const parsed = parseYaml(raw) as Partial<AgentdConfig> | null;

  return { ...defaults, ...parsed };
}
