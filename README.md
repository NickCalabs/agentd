# agentd

**The runtime for AI agents.** Sandboxing, tools, state, scheduling, and logging — one install, every agent.

```bash
curl -fsSL https://agentd.sh/install | sh
agentd start
```

![agentd demo](./demo.gif)

---

## The Problem

You write 50 lines of agent logic. Then you spend two weeks building the infrastructure around it:

- Docker for sandboxing
- Postgres for state
- Cron jobs that break on macOS
- MCP servers configured by hand
- Print statements for logging
- No cost tracking, no audit trail

Your second agent? Start over from scratch. Nothing is shared.

**agentd eliminates all of this.** Install once. Define agents in YAML. Everything works.

---

## 10 Days → 10 Minutes

**Before agentd:**

```
Day 1   Pick a framework
Day 2   Write 50 lines of agent logic
Day 3   Set up Docker for sandboxing
Day 4   Set up Postgres for state
Day 5   Configure MCP servers by hand
Day 6   Write cron job + shell wrapper
Day 7   Debug scheduling on macOS
Day 8   Add logging with print statements
Day 9   Bolt on token counting for costs
Day 10  It mostly works. Breaks on restart.
```

**After agentd:**

```
Minute 1    curl -fsSL https://agentd.sh/install | sh && agentd start
Minute 5    Write agent.yaml (15 lines)
Minute 8    agentd tools add @anthropic/gmail-mcp
Minute 10   agentd agents add inbox-bot
```

15 lines of YAML. Sandboxed. Persistent. Scheduled. Logged. Cost-tracked.

Your second agent? Another YAML file. Two minutes. Shares the same tools, sandbox pool, and observability.

---

## How It Works

agentd is a daemon that runs in the background on your machine. It provides five primitives every agent needs:

| Primitive | What It Does |
|-----------|-------------|
| **Sandbox** | Runs untrusted code in isolated containers. Your machine is untouched. |
| **Tools** | Auto-discovers MCP servers. Agents call tools — agentd routes them. |
| **State** | Persists agent memory across runs. No database setup required. |
| **Scheduler** | Cron, webhooks, file watchers, inter-agent triggers. |
| **Observability** | Every action traced. Every dollar tracked. |

You don't configure any of this. agentd handles it.

---

## Define an Agent

```yaml
# ~/.agentd/agents/inbox-bot/agent.yaml

name: inbox-bot
description: Checks my email and summarizes what's urgent

model: anthropic/claude-sonnet-4-5

tools:
  - gmail
  - filesystem
  - memory

triggers:
  - cron: "0 9 * * 1-5"     # weekdays at 9am
  - cron: "0 14 * * 1-5"    # weekdays at 2pm

prompt: |
  Check my Gmail inbox for unread messages from the last 12 hours.
  Flag anything urgent and draft a response.
  Save a summary to ~/inbox-summary.md.
  Remember which emails you've already processed.
```

```bash
agentd agents add inbox-bot
```

```
✓ inbox-bot registered
  next run: tomorrow at 9:00 AM
  tools: gmail, filesystem, memory
  sandbox: docker (L1)
```

Tomorrow at 9am, it runs. Automatically. In a sandbox. With persistent memory. With a full trace log.

---

## See What Your Agent Did

```bash
agentd logs inbox-bot
```

```
[2026-02-26 09:00:01] RUN #1 started (trigger: cron)
[2026-02-26 09:00:02] LLM  claude-sonnet-4-5 — 1,247 in / 89 out
[2026-02-26 09:00:03] TOOL gmail.list — 12 unread — 340ms
[2026-02-26 09:00:04] LLM  claude-sonnet-4-5 — 8,442 in / 1,891 out
[2026-02-26 09:00:07] TOOL filesystem.write — ~/inbox-summary.md
[2026-02-26 09:00:07] RUN #1 complete — 6.1s — $0.018
```

```bash
agentd costs
```

```
Agent            Runs    Tokens       Cost
inbox-bot         42    284,000     $0.76
code-reviewer     18    891,000     $2.41
───────────────────────────────────────────
Total             60  1,175,000     $3.17
```

---

## More Examples

<details>
<summary><b>Code reviewer that clones, tests, and comments on PRs</b></summary>

```yaml
name: code-reviewer
description: Reviews open PRs on my repos

model: anthropic/claude-sonnet-4-5

tools:
  - github
  - git
  - shell       # runs tests inside agentd's sandbox
  - memory

triggers:
  - cron: "0 10 * * 1-5"
  - webhook: /code-reviewer/run

prompt: |
  Check my open pull requests on GitHub.
  For each PR, read the diff, clone the branch into the sandbox,
  run the test suite, and post a review comment with findings.
  Skip PRs you've already reviewed.
```

The `shell` tool runs inside an isolated container. If the code tries to delete files, it deletes files inside the sandbox. Your machine is untouched. You didn't configure any of this.

</details>

<details>
<summary><b>Agents that trigger other agents</b></summary>

Your inbox-bot finds an email: "Critical bug — PR #247 has the fix."

```yaml
# Add to inbox-bot's agent.yaml
notify:
  - agent: code-reviewer
    when: "urgent PR found"
```

agentd routes the message. code-reviewer gets the context. No message queue. No pub/sub. One line.

</details>

<details>
<summary><b>Use agentd from Python (no YAML needed)</b></summary>

```python
from agentd import client

# Run code in a sandbox
result = client.sandbox.exec("python3 analyze.py", timeout=30)

# Call any discovered tool
messages = client.tools.call("gmail.list", query="is:unread")

# Persist state across runs
client.state.set("my-script", "last_run", "2026-02-25")

# Log a trace event
client.trace.event("my-script", "processed 5 emails", cost=0.003)
```

</details>

<details>
<summary><b>Use agentd as a backend for LangGraph / CrewAI</b></summary>

```python
from langgraph import StateGraph
from agentd.integrations.langgraph import AgentdCheckpointer, AgentdToolkit

graph = StateGraph()
graph.set_checkpointer(AgentdCheckpointer())  # state via agentd
graph.add_tools(AgentdToolkit())              # tools via agentd
```

Framework authors: stop reimplementing sandboxing, state, and scheduling. Build on agentd.

</details>

---

## Auto-Discovery

On `agentd start`, it finds what you already have:

```bash
agentd status
```

```
agentd v0.1.0 — running (pid 48291)
  sandbox: docker (L1)
  tools: 7 discovered
    ├─ filesystem (built-in)
    ├─ shell (built-in)
    ├─ git (built-in)
    ├─ github (from ~/.cursor/mcp.json)
    ├─ postgres (auto-detected on :5432)
    ├─ fetch (built-in)
    └─ memory (built-in)
  agents: 0 registered
```

It scans your Cursor, Claude Desktop, and VS Code MCP configs. It probes well-known local services. It registers built-in tools. Zero configuration.

Add more tools anytime:

```bash
agentd tools add @anthropic/gmail-mcp
agentd tools list
```

---

## What agentd Is Not

- **Not a framework.** Use any framework on top — or use none. YAML is enough.
- **Not a model.** Bring your own API keys. Works with Anthropic, OpenAI, Ollama, anything.
- **Not a cloud service.** Runs on your machine. Your data stays local.
- **Not an MCP server.** It's an MCP *client* that connects to every server in the ecosystem — and exposes itself as a single MCP endpoint for AI tools like Claude and Cursor.

---

## Install

```bash
# Recommended
curl -fsSL https://agentd.sh/install | sh

# Or via npm
npm install -g agentd

# Start the daemon
agentd start
```

Requires Node.js 22+. Docker optional (enables container sandboxing).

---

<!-- TODO: docs site
## Documentation

→ [Getting Started](https://agentd.sh/docs/getting-started)
→ [Agent YAML Reference](https://agentd.sh/docs/agent-yaml)
→ [CLI Reference](https://agentd.sh/docs/cli)
→ [Python SDK](https://agentd.sh/docs/sdk/python)
→ [TypeScript SDK](https://agentd.sh/docs/sdk/typescript)

## Community

→ [GitHub Discussions](https://github.com/agentd-sh/agentd/discussions)
→ [Share your agent](https://github.com/agentd-sh/agentd/discussions/categories/show-and-tell)
-->

## License

MIT