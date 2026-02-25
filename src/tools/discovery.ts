import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";
import { glob } from "node:fs/promises";
import { registerServer } from "./registry.ts";

export type DiscoverySource = "built-in" | "cursor" | "claude-desktop" | "agentd-tools";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

interface DiscoveryTarget {
  path: string;
  source: DiscoverySource;
  replace: boolean;
}

function getDiscoveryTargets(): DiscoveryTarget[] {
  const home = homedir();
  const targets: DiscoveryTarget[] = [
    { path: join(home, ".cursor", "mcp.json"), source: "cursor", replace: false },
  ];

  if (platform() === "darwin") {
    targets.push({
      path: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      source: "claude-desktop",
      replace: false,
    });
  } else {
    targets.push({
      path: join(home, ".config", "Claude", "claude_desktop_config.json"),
      source: "claude-desktop",
      replace: false,
    });
  }

  return targets;
}

async function loadConfigFile(path: string): Promise<McpConfigFile | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as McpConfigFile;
  } catch {
    console.warn(`Warning: failed to parse MCP config at ${path}`);
    return null;
  }
}

async function registerFromConfig(
  config: McpConfigFile,
  source: DiscoverySource,
  replace: boolean,
): Promise<void> {
  const servers = config.mcpServers;
  if (!servers) return;

  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      await registerServer(
        name,
        { command: serverConfig.command, args: serverConfig.args ?? [], env: serverConfig.env },
        source,
        { replace },
      );
      console.log(`Registered MCP server: ${name} (source: ${source})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: failed to register MCP server "${name}" from ${source}: ${msg}`);
    }
  }
}

export async function discoverMcpServers(): Promise<void> {
  // 1. Scan known config files (Cursor, Claude Desktop)
  for (const target of getDiscoveryTargets()) {
    const config = await loadConfigFile(target.path);
    if (config) {
      await registerFromConfig(config, target.source, target.replace);
    }
  }

  // 2. Scan ~/.agentd/tools/*.json (user overrides, replace on conflict)
  const toolsDir = join(homedir(), ".agentd", "tools");
  if (!existsSync(toolsDir)) return;

  for await (const entry of glob(join(toolsDir, "*.json"))) {
    const config = await loadConfigFile(entry);
    if (config) {
      await registerFromConfig(config, "agentd-tools", true);
    }
  }
}
