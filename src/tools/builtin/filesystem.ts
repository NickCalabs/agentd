import { homedir } from "node:os";

export function filesystemServerConfig(allowedDirectories?: string[]) {
  const dirs = allowedDirectories ?? [homedir()];
  return { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", ...dirs] };
}
