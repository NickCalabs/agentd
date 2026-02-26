import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
export const AGENTD_DIR = join(homedir(), ".agentd");
export const PID_FILE = join(AGENTD_DIR, "agentd.pid");
export const CONFIG_FILE = join(AGENTD_DIR, "config.yaml");
export const DEFAULT_PORT = 4700;
export const DEFAULT_HOST = "localhost";
export function ensureAgentdDir() {
    if (!existsSync(AGENTD_DIR)) {
        mkdirSync(AGENTD_DIR, { recursive: true });
    }
}
export function loadApiKey() {
    if (process.env.ANTHROPIC_API_KEY) {
        return process.env.ANTHROPIC_API_KEY;
    }
    if (!existsSync(CONFIG_FILE))
        return null;
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed.api_key === "string") {
        return parsed.api_key;
    }
    return null;
}
export function loadConfig() {
    const defaults = {
        port: DEFAULT_PORT,
        host: DEFAULT_HOST,
    };
    if (!existsSync(CONFIG_FILE)) {
        return defaults;
    }
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = parseYaml(raw);
    return { ...defaults, ...parsed };
}
