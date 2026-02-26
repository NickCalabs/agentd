import { homedir } from "node:os";
import { join } from "node:path";
export function filesystemServerConfig(allowedDirectories) {
    const dirs = allowedDirectories ?? [join(homedir(), ".agentd"), process.cwd()];
    return { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", ...dirs] };
}
