# agentd — The Developer Story

## The Problem (What Hurts Right Now)

You're a developer in February 2026. You want to build an AI agent that does something useful — checks your email every morning, reviews PRs, monitors your servers, whatever. Here's what you actually go through today:

### Step 1: You pick a framework

LangGraph? CrewAI? AutoGen? Semantic Kernel? OpenAI Agents SDK? There are 30+ options. You spend two days reading comparison articles. You pick LangGraph because it seems mature.

### Step 2: You write your agent logic

This part is actually fine. 50 lines of Python. The AI part — calling Claude, defining tools, writing the prompt — takes an afternoon.

### Step 3: The infrastructure nightmare begins

Your agent needs to run a shell command to check something on your machine. Now you need to figure out sandboxing. Do you trust the AI not to delete your files? No. So you need Docker. You write a Dockerfile. You figure out volume mounts so the agent can access what it needs but not everything. You debug container networking for two hours.

Your agent needs to remember what it did yesterday. LangGraph has "checkpoints" but they require a Postgres database or a Redis instance. You spin up Postgres in Docker. You configure connection strings. You write migration scripts.

Your agent needs to run every morning at 9am. LangGraph doesn't have a scheduler. You write a cron job. The cron job needs to activate your Python virtualenv, set environment variables, and handle failures. You write a wrapper shell script. It breaks on macOS because launchd works differently than cron.

Your agent needs to read files and access your Git repos. You set up MCP servers manually. You write JSON config files pointing to each server. You debug stdio transport issues. One server crashes silently and you don't know why.

Your agent needs to call a different tool — say, your database. You install another MCP server. You update your config. You restart everything. The new server conflicts with the old one because they both expose a tool called "query."

Now you want to know what your agent actually did at 9am. Did it work? What tools did it call? How much did it cost? You have print statements scattered through your code. You grep through log files. You have no idea what the token costs were.

### Step 4: You realize you've spent two weeks on plumbing

Your actual agent logic is 50 lines. The infrastructure around it is 2,000 lines of config files, shell scripts, Dockerfiles, database schemas, and glue code. And it's fragile. When your laptop restarts, three things break and you spend an hour figuring out which ones.

### Step 5: You build a second agent

You want another agent that monitors your GitHub notifications. You go through the entire process again. Different state management. Different scheduling approach. The two agents can't share tools or state. They don't know about each other.

**This is the problem.** Every developer building AI agents today spends 90% of their time on infrastructure that has nothing to do with what their agent actually does. And every new agent starts from scratch.

---

## What agentd Does About It

agentd is a daemon that runs in the background on your machine. It provides five things that every agent needs but nobody wants to build: sandboxing, tools, state, scheduling, and logging. You install it once. It runs forever. Every agent you build from that point forward uses it.

---

## The Developer Experience (Start to Finish)

### Installation (60 seconds)

```bash
npm install -g agentd
agentd start
```

That's it. agentd is now running as a background daemon on localhost:4700. It auto-detected Docker on your machine (optional, for sandboxing). It scanned your system and found three MCP servers you already had configured for Cursor. It registered your filesystem, shell, and Git as built-in tools.

You can confirm it's working:

```bash
agentd status
```
```
agentd v0.1.0 — running (pid 48291)
  port: 4700
  uptime: 12s
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
  storage: ~/.agentd/
```

### Building Your First Agent (10 minutes)

You don't need a framework. You don't need LangGraph or CrewAI. You write a YAML file:

```yaml
# ~/.agentd/agents/inbox-bot/agent.yaml

name: inbox-bot
description: Checks my email and summarizes what's urgent

model: anthropic/claude-sonnet-4-5

tools:
  - gmail         # you'll add this MCP server in a sec
  - filesystem    # already discovered
  - memory        # built-in, persists facts across runs

triggers:
  - cron: "0 9 * * 1-5"    # weekdays at 9am
  - cron: "0 14 * * 1-5"   # weekdays at 2pm

prompt: |
  Check my Gmail inbox for unread messages from the last 12 hours.
  For each message:
    - If it's urgent or needs a reply, flag it and draft a response
    - If it's informational, add it to the summary
    - If it's spam or irrelevant, skip it
  
  Save the summary to ~/inbox-summary.md.
  Remember which emails you've already processed so you don't repeat yourself.
```

You need the Gmail MCP server. One command:

```bash
agentd tools add @anthropic/gmail-mcp
# Installed. Set GMAIL_OAUTH_TOKEN in ~/.agentd/config.yaml to authenticate.
```

You add your token to the config. Register the agent:

```bash
agentd agents add inbox-bot
```
```
✓ inbox-bot registered
  next run: tomorrow at 9:00 AM
  tools: gmail, filesystem, memory
  sandbox: docker (L1)
```

Done. Tomorrow at 9am, this agent runs automatically. It reads your email, writes a summary, remembers what it's seen, and does it again at 2pm.

### Checking What Your Agent Did (Anytime)

```bash
agentd logs inbox-bot
```
```
[2026-02-26 09:00:01] RUN #1 started (trigger: cron)
[2026-02-26 09:00:02] LLM call — claude-sonnet-4-5 — 1,247 tokens in, 89 tokens out
[2026-02-26 09:00:03] TOOL gmail.list — 12 unread messages — 340ms
[2026-02-26 09:00:04] LLM call — claude-sonnet-4-5 — 8,442 tokens in, 1,891 tokens out
[2026-02-26 09:00:07] TOOL filesystem.write — ~/inbox-summary.md — 14ms
[2026-02-26 09:00:07] TOOL memory.set — processed_ids: [msg_a1, msg_a2, ...] 
[2026-02-26 09:00:07] RUN #1 complete — 6.1s — $0.018
```

Full trace with every detail:

```bash
agentd trace inbox-bot --last
```

Cost report for the month:

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

### Building Your Second Agent (5 minutes)

You want an agent that reviews your pull requests. Another YAML file:

```yaml
# ~/.agentd/agents/code-reviewer/agent.yaml

name: code-reviewer
description: Reviews open PRs on my repos

model: anthropic/claude-sonnet-4-5

tools:
  - github       # already discovered from Cursor config
  - git          # built-in
  - shell        # for running tests — sandboxed automatically
  - memory

triggers:
  - webhook: /code-reviewer/run    # POST to trigger manually
  - cron: "0 10 * * 1-5"          # also runs daily at 10am

prompt: |
  Check my open pull requests on GitHub.
  For each PR:
    - Read the diff
    - Clone the branch into the sandbox and run the test suite
    - Post a review comment with findings
  Skip PRs you've already reviewed (check memory).
```

```bash
agentd agents add code-reviewer
```

This agent clones code and runs tests. That code runs inside agentd's sandbox — an isolated Docker container with its own filesystem. If the code has a bug that tries to delete files, it deletes files inside the container. Your machine is untouched. You didn't configure any of this. agentd did it automatically because the agent uses the `shell` tool.

### Making Agents Talk to Each Other

Your inbox-bot finds an email saying "Critical bug in production — PR #247 has the fix." You want it to automatically trigger code-reviewer to look at that PR.

Add one line to inbox-bot's YAML:

```yaml
notify:
  - agent: code-reviewer
    when: "urgent PR found"
```

Or do it programmatically from a script:

```python
from agentd import client

# Tell code-reviewer to look at a specific PR
client.agents.trigger("code-reviewer", context={
    "pr_number": 247,
    "reason": "Flagged as urgent by inbox-bot"
})
```

agentd handles the routing. code-reviewer gets the context. You didn't build a message queue or pub/sub system.

### Using agentd From Existing Code (SDK)

Maybe you don't want YAML agents. You have a Python script and you just want agentd's infrastructure. Fine:

```python
from agentd import client

# Run code in a sandbox
result = client.sandbox.exec(
    "python3 -c 'import pandas; print(pandas.__version__)'",
    image="python:3.12",   # optional, defaults to agentd's base image
    timeout=30
)
print(result.stdout)   # "2.2.0"
print(result.exit_code) # 0

# Call any discovered tool
messages = client.tools.call("gmail.list", query="is:unread", max_results=5)

# Store state
client.state.set("my-script", "last_run", "2026-02-25T10:00:00Z")
last_run = client.state.get("my-script", "last_run")

# Log a trace event (shows up in agentd logs)
client.trace.event("my-script", "processed 5 emails", cost=0.003)
```

You use agentd as a utility library. Your script doesn't need to know about Docker, MCP protocols, SQLite state management, or logging infrastructure. One import. Five methods.

### Using agentd From a Framework (LangGraph, CrewAI, etc.)

Framework authors integrate agentd as their backend:

```python
# Before agentd: LangGraph with manual infrastructure
from langgraph import StateGraph
from langgraph.checkpoint.postgres import PostgresSaver  # you need Postgres running
import docker  # you need Docker SDK
import subprocess  # you need shell access

# After agentd: LangGraph uses agentd for infrastructure
from langgraph import StateGraph
from agentd.integrations.langgraph import AgentdCheckpointer, AgentdToolkit

graph = StateGraph()
graph.set_checkpointer(AgentdCheckpointer())  # state handled by agentd
graph.add_tools(AgentdToolkit())              # tools handled by agentd
# Everything else is your LangGraph logic as normal
```

The framework author doesn't reimplement infrastructure. They plug into agentd's primitives. The developer using the framework gets sandboxing, persistence, and tools without knowing agentd exists.

---

## Before agentd vs. After agentd

### Before: Building an email-checking agent

```
Day 1:  Research frameworks (LangGraph vs CrewAI vs ...)
Day 2:  Write 50 lines of agent logic
Day 3:  Set up Docker for sandboxing
Day 4:  Set up Postgres for state persistence
Day 5:  Configure MCP servers manually
Day 6:  Write cron job + shell wrapper for scheduling
Day 7:  Debug cron job (launchd on Mac is different)
Day 8:  Add logging (print statements → log files)
Day 9:  Realize you have no cost tracking, add token counting
Day 10: It mostly works. Fragile. Breaks when laptop restarts.

Result: 50 lines of agent logic + 2,000 lines of infrastructure
```

### After: Building an email-checking agent

```
Minute 1:  npm install -g agentd && agentd start
Minute 5:  Write agent.yaml (15 lines)
Minute 8:  agentd tools add @anthropic/gmail-mcp
Minute 10: agentd agents add inbox-bot

Result: 15 lines of YAML. Sandboxed. Persistent. Scheduled. Logged. Tracked.
```

### Before: Building a second agent

```
Day 1: Start the infrastructure process again from scratch
Day 3: Realize the two agents can't share state or tools
Day 5: Build custom glue code to connect them

Result: 2× the infrastructure. No shared anything.
```

### After: Building a second agent

```
Minute 1: Write another agent.yaml (15 lines)
Minute 2: agentd agents add code-reviewer

Result: Both agents share the same tool registry, the same sandbox pool,
        the same observability. They can message each other in one line.
```

---

## Who Uses This and Why

### Individual developer (your core user)

**Pain:** "I want AI agents that do things for me, but I'm not going to run Postgres and manage Docker configs just to check my email."

**agentd gives them:** Install once, define agents in YAML, everything just works. They focus on what the agent does, not how it runs.

### Startup building an AI product

**Pain:** "We're building an AI coding assistant. We need sandboxed code execution, tool access, and persistent state. Building this from scratch takes our team three months."

**agentd gives them:** Import the SDK. Call `client.sandbox.exec()` for sandboxed execution. Call `client.tools.call()` for tool access. Ship your product in two weeks instead of three months.

### Framework maintainer (LangGraph, CrewAI)

**Pain:** "Every release, we get 50 issues about state persistence, 30 about sandboxing, and 20 about scheduling. We maintain infrastructure code that has nothing to do with our actual value."

**agentd gives them:** Drop the infrastructure code. Depend on agentd for sandboxing, state, and scheduling. Focus on what makes your framework unique — orchestration patterns, agent coordination, reasoning strategies.

### Enterprise platform team

**Pain:** "Our developers are building agents with no isolation, no audit trails, and no cost controls. Compliance is a nightmare."

**agentd gives them:** Every agent runs sandboxed. Every action is traced. Every dollar is tracked. Deploy agentd on shared infra with auth tokens and resource limits per team.

---

## The Simplicity Test

The test for whether agentd has achieved its goal:

**A developer with zero agent experience should go from nothing to a working, 
scheduled, sandboxed, persistent, logged AI agent in under 10 minutes.**

If that takes longer than 10 minutes, the product has failed.

If building a second agent takes more than 2 minutes, the product has failed.

If the developer ever has to think about Docker, Postgres, cron syntax, 
MCP transport protocols, or SQLite schemas, the product has failed.

The infrastructure is invisible. The agent is everything.