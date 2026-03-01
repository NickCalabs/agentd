import { execSync, execFileSync } from "node:child_process";
import type { LocalToolDef } from "../registry.ts";

const ENV_BLOCKLIST_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "OPENAI_API_KEY",
]);

const ENV_BLOCKLIST_SUFFIXES = ["_TOKEN", "_SECRET", "_PASSWORD"];

function isBlockedEnvVar(name: string): boolean {
  if (ENV_BLOCKLIST_EXACT.has(name)) return true;
  const upper = name.toUpperCase();
  return ENV_BLOCKLIST_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

export const shellTools: LocalToolDef[] = [
  {
    name: "run_command",
    description:
      "Execute a program directly without shell interpretation. Does not support shell features like pipes, redirects, or globbing. For those, use run_shell.",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", description: "Program to execute (e.g. 'ls', 'git', 'python3')" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments to pass to the program",
        },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["program"],
    },
    handler: async (args) => {
      const program = String(args.program);
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const cwd = args.cwd ? String(args.cwd) : undefined;
      try {
        const output = execFileSync(program, cmdArgs, {
          cwd,
          timeout: 30_000,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        });
        return { content: [{ type: "text", text: output }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  },
  {
    name: "run_shell",
    description:
      "Execute a shell command string. Supports pipes, redirects, globbing, and other shell features. Prefer run_command when shell features are not needed.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
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
      } catch (err: unknown) {
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
      } catch {
        return { content: [{ type: "text", text: `Command "${args.command}" not found` }], isError: true };
      }
    },
  },
];
