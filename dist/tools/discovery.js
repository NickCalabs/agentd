import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";
import { glob } from "node:fs/promises";
import { registerServer } from "./registry.js";
function getDiscoveryTargets() {
    const home = homedir();
    const targets = [
        { path: join(home, ".cursor", "mcp.json"), source: "cursor", replace: false },
    ];
    if (platform() === "darwin") {
        targets.push({
            path: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
            source: "claude-desktop",
            replace: false,
        });
    }
    else {
        targets.push({
            path: join(home, ".config", "Claude", "claude_desktop_config.json"),
            source: "claude-desktop",
            replace: false,
        });
    }
    return targets;
}
async function loadConfigFile(path) {
    if (!existsSync(path))
        return null;
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        console.warn(`Warning: failed to parse MCP config at ${path}`);
        return null;
    }
}
async function registerFromConfig(config, source, replace) {
    const servers = config.mcpServers;
    if (!servers)
        return;
    for (const [name, serverConfig] of Object.entries(servers)) {
        try {
            await registerServer(name, { command: serverConfig.command, args: serverConfig.args ?? [], env: serverConfig.env }, source, { replace });
            console.log(`Registered MCP server: ${name} (source: ${source})`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`Warning: failed to register MCP server "${name}" from ${source}: ${msg}`);
        }
    }
}
export async function discoverMcpServers() {
    // 1. Scan known config files (Cursor, Claude Desktop)
    for (const target of getDiscoveryTargets()) {
        const config = await loadConfigFile(target.path);
        if (config) {
            await registerFromConfig(config, target.source, target.replace);
        }
    }
    // 2. Scan ~/.agentd/tools/*.json (user overrides, replace on conflict)
    const toolsDir = join(homedir(), ".agentd", "tools");
    if (!existsSync(toolsDir))
        return;
    for await (const entry of glob(join(toolsDir, "*.json"))) {
        const config = await loadConfigFile(entry);
        if (config) {
            await registerFromConfig(config, "agentd-tools", true);
        }
    }
}
