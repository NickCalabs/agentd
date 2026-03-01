// Blocklist for sensitive environment variables that should not leak to subprocesses.

const BLOCKED_ENV_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
]);

const BLOCKED_ENV_SUFFIXES = ["_TOKEN", "_SECRET", "_PASSWORD", "_API_KEY"];

export function isBlockedEnvVar(name: string): boolean {
  if (BLOCKED_ENV_EXACT.has(name)) return true;
  const upper = name.toUpperCase();
  return BLOCKED_ENV_SUFFIXES.some((s) => upper.endsWith(s));
}

/** Return a copy of `env` with sensitive variables removed. */
export function filterEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isBlockedEnvVar(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}
