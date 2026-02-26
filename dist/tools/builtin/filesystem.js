import { homedir } from "node:os";
export function filesystemServerConfig(allowedDirectories) {
    const dirs = allowedDirectories ?? [homedir()];
    return { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", ...dirs] };
}
