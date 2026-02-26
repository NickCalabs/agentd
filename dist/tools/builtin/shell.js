import { execSync, execFileSync } from "node:child_process";
const ENV_BLOCKLIST_EXACT = new Set([
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "OPENAI_API_KEY",
]);
const ENV_BLOCKLIST_SUFFIXES = ["_TOKEN", "_SECRET", "_PASSWORD"];
function isBlockedEnvVar(name) {
    if (ENV_BLOCKLIST_EXACT.has(name))
        return true;
    const upper = name.toUpperCase();
    return ENV_BLOCKLIST_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}
export const shellTools = [
    {
        name: "run_command",
        description: "Execute a shell command and return its output",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to execute" },
                cwd: { type: "string", description: "Working directory (optional)" },
            },
            required: ["command"],
        },
        handler: async (args) => {
            const cmd = String(args.command);
            const cwd = args.cwd ? String(args.cwd) : undefined;
            try {
                const output = execSync(cmd, { cwd, timeout: 30_000, encoding: "utf-8", maxBuffer: 1024 * 1024 });
                return { content: [{ type: "text", text: output }] };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { content: [{ type: "text", text: msg }], isError: true };
            }
        },
    },
    {
        name: "read_env",
        description: "Read the value of an environment variable",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Environment variable name" },
            },
            required: ["name"],
        },
        handler: async (args) => {
            const name = String(args.name);
            if (isBlockedEnvVar(name)) {
                return { content: [{ type: "text", text: "[REDACTED]" }] };
            }
            const val = process.env[name];
            if (val === undefined) {
                return { content: [{ type: "text", text: `Environment variable "${name}" is not set` }], isError: true };
            }
            return { content: [{ type: "text", text: val }] };
        },
    },
    {
        name: "which",
        description: "Find the path of a command",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "Command name to look up" },
            },
            required: ["command"],
        },
        handler: async (args) => {
            try {
                const output = execFileSync("which", [String(args.command)], { encoding: "utf-8", timeout: 5_000 }).trim();
                return { content: [{ type: "text", text: output }] };
            }
            catch {
                return { content: [{ type: "text", text: `Command "${args.command}" not found` }], isError: true };
            }
        },
    },
];
