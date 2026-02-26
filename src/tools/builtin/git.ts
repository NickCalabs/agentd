import { execSync } from "node:child_process";
import type { LocalToolDef } from "../registry.ts";

function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, { cwd, timeout: 15_000, encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim();
}

export const gitTools: LocalToolDef[] = [
  {
    name: "status",
    description: "Show the working tree status (git status)",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository path (optional)" },
      },
    },
    handler: async (args) => {
      try {
        const output = git("status --short", args.cwd as string | undefined);
        return { content: [{ type: "text", text: output || "(clean)" }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  },
  {
    name: "diff",
    description: "Show changes in the working tree (git diff)",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository path (optional)" },
        staged: { type: "boolean", description: "Show staged changes only" },
      },
    },
    handler: async (args) => {
      try {
        const flag = args.staged ? " --cached" : "";
        const output = git(`diff${flag}`, args.cwd as string | undefined);
        return { content: [{ type: "text", text: output || "(no changes)" }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  },
  {
    name: "log",
    description: "Show recent commit history (git log)",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository path (optional)" },
        count: { type: "number", description: "Number of commits to show (default: 10)" },
      },
    },
    handler: async (args) => {
      try {
        const n = Number(args.count) || 10;
        const output = git(`log --oneline -n ${n}`, args.cwd as string | undefined);
        return { content: [{ type: "text", text: output }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  },
  {
    name: "show",
    description: "Show details of a specific commit (git show)",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Commit ref (default: HEAD)" },
        cwd: { type: "string", description: "Repository path (optional)" },
      },
    },
    handler: async (args) => {
      try {
        const ref = String(args.ref || "HEAD");
        const output = git(`show --stat ${ref}`, args.cwd as string | undefined);
        return { content: [{ type: "text", text: output }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  },
];
