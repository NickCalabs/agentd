# agentd — The Universal Agent Runtime

## What This Document Is

A holistic technical and strategic blueprint for building a local-first, universal agent runtime daemon. Written for a team of 4–5 engineers who need to understand what they're building, why each piece exists, how the pieces connect, and what it costs.

The thesis: every AI agent framework today reinvents sandboxing, persistence, tool execution, and scheduling. agentd is the layer *beneath* the frameworks — the way Node.js is the runtime beneath Express, Koa, and Fastify. Frameworks become optional. The runtime becomes the standard.

---

## Part 1: The System Map

### What agentd Actually Is

A background daemon (like Docker's `dockerd`, or systemd) that provides five core primitives to any agent — regardless of what framework, language, or model powers it:

1. **Sandboxed Execution** — run untrusted code safely
2. **Tool Registry** — discover and call tools (MCP-native)
3. **State & Memory** — persist agent state across runs
4. **Scheduler** — trigger agents on time, events, or webhooks
5. **Observability** — trace every action for debugging and audit

That's it. Five primitives. Everything else is userland.

### The Component Map

```
┌─────────────────────────────────────────────────────┐
│                    User's Machine                    │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Agent A  │  │ Agent B  │  │ Agent C          │  │
│  │ (Python) │  │ (TS/JS)  │  │ (LangGraph)      │  │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│       │              │                  │            │
│       ▼              ▼                  ▼            │
│  ┌──────────────────────────────────────────────┐   │
│  │              agentd API (gRPC + REST)         │   │
│  │                localhost:4700                  │   │
│  └──────────────┬───────────────────────────────┘   │
│                  │                                    │
│  ┌───────┬───────┼───────┬──────────┬────────────┐  │
│  │       │       │       │          │            │  │
│  ▼       ▼       ▼       ▼          ▼            ▼  │
│ Sand-  Tool    State   Sched-   Observ-    Auth   │  │
│ box    Reg.    Store   uler     ability    Gate   │  │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │           MCP Server Layer (auto-discovered)  │   │
│  │  filesystem │ git │ browser │ db │ calendar   │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## Part 2: The Five Primitives (Detailed)

### Primitive 1: Sandboxed Execution

**What it does:** Runs arbitrary code (shell commands, scripts, tool calls) inside isolated environments so a rogue agent can't `rm -rf /` your machine.

**Why it matters:** This is the #1 blocker to production agent deployment. The July 2025 Replit incident — where an AI coding agent deleted a production database — proved that unsandboxed agent execution is an unacceptable risk. Every serious deployment needs isolation.

**Implementation layers (progressively stronger):**

| Level | Mechanism | Latency | Security | Use Case |
|-------|-----------|---------|----------|----------|
| L0 | Process-level (spawn + cgroup) | ~5ms | Low | Dev/local scripts |
| L1 | Container (OCI/Docker) | ~200ms | Medium | Tool execution |
| L2 | microVM (Firecracker/gVisor) | ~500ms | High | Untrusted code |
| L3 | Remote sandbox (E2B-style) | ~1s | Highest | Multi-tenant / prod |

**The user should never think about this.** agentd picks the right level based on context. Local dev agent? L0. Running code from the internet? L2. The config is one line:

```yaml
# ~/.agentd/config.yaml
sandbox:
  default: container    # L1
  untrusted: microvm    # L2
```

**Key dependencies:**
- Container runtime: containerd or Docker Engine (most machines already have Docker)
- Optional microVM: Firecracker (requires KVM on Linux) or gVisor (works everywhere)
- Filesystem isolation: overlayfs for copy-on-write per-agent workspaces
- Network isolation: iptables/nftables rules per sandbox

**What to build:**
- A `SandboxManager` service that pools warm containers/microVMs
- Pre-warmed images for Python 3.12, Node 22, and a minimal shell environment
- A stdio bridge: agent sends code → sandbox executes → agent gets stdout/stderr/exit code
- Resource limits: CPU, memory, disk, network per sandbox
- Timeout enforcement: hard-kill after configurable duration

**Estimated effort:** 3–4 weeks for L0+L1. Another 3 weeks for L2. L3 is out of scope for MVP.

---

### Primitive 2: Tool Registry (MCP-Native)

**What it does:** Discovers, registers, and routes tool calls to MCP servers. An agent says "read this file" — the registry knows which MCP server handles filesystem operations and routes the call.

**Why it matters:** MCP is becoming the USB standard for AI tools. The Linux Foundation's Agentic AI Foundation (Anthropic, Block, OpenAI) is standardizing around it. Building MCP-native from day one means agentd is compatible with every tool in the ecosystem without adapters.

**How it works:**

```
Agent: "I need to read /Users/me/report.pdf"
    │
    ▼
agentd Tool Registry
    │
    ├─ Lookup: which server handles filesystem?
    │   → @modelcontextprotocol/server-filesystem (auto-discovered)
    │
    ├─ Route call to that server
    │
    ├─ Return result to agent
    │
    └─ Log the call (observability)
```

**Auto-discovery is the killer feature.** On `agentd start`:
1. Scan `~/.agentd/tools/` for manually registered servers
2. Scan `~/.cursor/mcp.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`, etc. for existing MCP configs the user already has
3. Probe well-known local services (PostgreSQL on 5432, Redis on 6379, etc.)
4. Register built-in tools: filesystem, shell, HTTP fetch

**What to build:**
- MCP client implementation (the agentd daemon *is* an MCP client that connects to multiple MCP servers)
- MCP server implementation (agentd also *exposes* itself as an MCP server, so any MCP-compatible AI client can use agentd as a single endpoint)
- A tool catalog: name, description, schema, which server, auth requirements
- `agentd tools list` — show all discovered tools
- `agentd tools add <npm-package-or-url>` — install a new MCP server
- Conflict resolution: if two servers both handle "filesystem", which one wins?

**Key dependencies:**
- MCP SDK (TypeScript: `@modelcontextprotocol/sdk`, Python: `mcp` package)
- JSON-RPC 2.0 transport (MCP's wire protocol)
- stdio and SSE transports for different server types

**Estimated effort:** 2–3 weeks for core registry + auto-discovery. Ongoing for expanding built-in tools.

---

### Primitive 3: State & Memory

**What it does:** Persists agent state, conversation history, and learned facts across sessions. An agent that ran yesterday can pick up where it left off today.

**Why it matters:** Stateless agents are toys. Production agents need to remember what they've done, what they've learned, and what they're in the middle of. Every framework today builds its own state management. agentd standardizes it.

**Three layers of state:**

| Layer | What It Stores | Storage | TTL |
|-------|---------------|---------|-----|
| Session | Current conversation, tool call history | SQLite | Until reset |
| Agent | Agent-specific config, learned preferences | SQLite + files | Permanent |
| Global | Cross-agent facts (user prefs, system info) | SQLite + vector store | Permanent |

**The user flow:**

```python
from agentd import Agent

agent = Agent("inbox-bot")

# Session state — auto-managed
agent.run("check my inbox")
# agentd stores the full interaction: prompt, tool calls, responses

# Agent state — explicit
agent.state.set("last_check", "2026-02-25T10:00:00Z")
agent.state.get("last_check")  # persists across runs

# Global state — shared across agents
from agentd import memory
memory.set("user.timezone", "America/New_York")
# Now every agent knows the user's timezone
```

**For the memory/RAG layer (optional but powerful):**
- Embed conversation summaries into a local vector store
- On each new run, retrieve relevant past context
- This is where agentd overlaps with the "universal memory layer" concept — but scoped to agents, not all AI tools

**What to build:**
- SQLite-based state store (one DB per agent, one global DB)
- Key-value API: `get`, `set`, `delete`, `list`
- Session log: append-only log of every interaction
- Optional: embedded vector store (sqlite-vss or lancedb) for semantic retrieval
- `agentd state export <agent>` — dump state as JSON (portability)
- `agentd state clear <agent>` — nuclear reset

**Key dependencies:**
- SQLite (ships with every OS, zero config)
- better-sqlite3 (Node) or sqlite3 (Python) bindings
- Optional: lancedb or sqlite-vss for vector search
- Optional: an embedding model (local via Ollama, or API-based)

**Estimated effort:** 2 weeks for core state. 2 more weeks for vector/memory layer.

---

### Primitive 4: Scheduler

**What it does:** Triggers agent runs based on time (cron), events (webhooks, file changes), or other agents (inter-agent messaging).

**Why it matters:** The difference between a tool and an assistant is that an assistant acts without being asked. A scheduler turns agents from reactive scripts into proactive systems.

**Trigger types:**

| Trigger | Example | Mechanism |
|---------|---------|-----------|
| Cron | "Every morning at 9am" | OS cron or internal scheduler |
| Webhook | "When Stripe sends a payment event" | HTTP listener on agentd |
| File watch | "When ~/Downloads changes" | fsnotify/inotify |
| Inter-agent | "When inbox-bot finds urgent mail" | Internal pub/sub |
| Manual | `agentd run inbox-bot` | CLI |

**The user flow:**

```yaml
# ~/.agentd/agents/inbox-bot.yaml
name: inbox-bot
model: anthropic/claude-sonnet-4-5
triggers:
  - cron: "0 9 * * *"        # 9am daily
  - cron: "0 14 * * *"       # 2pm daily
  - webhook: /inbox-bot/run   # POST to trigger manually
prompt: |
  Check my Gmail inbox. Summarize anything urgent.
  If there's something that needs a response, draft one and save it.
tools:
  - gmail
  - filesystem
```

```bash
agentd agents add inbox-bot.yaml
agentd agents list
# inbox-bot  next-run: 2026-02-26T09:00:00  status: idle
```

**What to build:**
- A lightweight internal scheduler (node-cron or APScheduler equivalent)
- A webhook HTTP server (runs on agentd's port, routes by path)
- File system watcher (chokidar/watchman)
- Inter-agent pub/sub (in-process event bus)
- Agent lifecycle: idle → starting → running → complete/error → idle
- Queue: if an agent is already running when triggered, queue or skip

**Key dependencies:**
- cron parser library
- HTTP server (already needed for REST API)
- File watcher (chokidar for Node, watchdog for Python)

**Estimated effort:** 2 weeks for cron + webhook + CLI triggers. 1 more week for file watch + inter-agent.

---

### Primitive 5: Observability

**What it does:** Records every action an agent takes — every tool call, every LLM request, every state mutation — in a structured, queryable trace.

**Why it matters:** Two reasons. First, debugging: when an agent does something wrong, you need the full trace to figure out why. Second, compliance: the EU AI Act requires auditability for high-risk AI systems. Enterprises won't adopt agent infrastructure without it.

**The trace model:**

```
Run #472 — inbox-bot — 2026-02-25T09:00:03Z
├─ LLM call: claude-sonnet-4-5 (1,247 input tokens, 382 output tokens, $0.003)
│  └─ Response: "I'll check your Gmail inbox now."
├─ Tool call: gmail.list_messages(query="is:unread")
│  └─ Result: 7 unread messages (143ms)
├─ LLM call: claude-sonnet-4-5 (3,891 input tokens, 1,204 output tokens, $0.009)
│  └─ Response: "Here's your summary..."
├─ Tool call: filesystem.write("/Users/me/inbox-summary.md", ...)
│  └─ Result: OK (12ms)
├─ State mutation: last_check = "2026-02-25T09:00:07Z"
└─ Run complete — 4.2s — $0.012 total cost
```

**What to build:**
- OpenTelemetry-compatible trace format (spans, events, attributes)
- Local trace storage (SQLite or append-only log files)
- `agentd logs <agent>` — tail recent runs
- `agentd trace <run-id>` — full trace for a specific run
- Cost tracking: token counts × model pricing = per-run cost
- Optional: web dashboard (simple HTML served from agentd's HTTP port)
- Alerts: "this agent spent > $1 in the last hour" → notification

**Key dependencies:**
- OpenTelemetry SDK (for trace format compatibility)
- SQLite (reuse the same state DB or a separate traces DB)
- Optional: a simple web UI framework (Hono + HTMX, or similar)

**Estimated effort:** 2 weeks for core tracing + CLI. 2 more weeks for web dashboard + cost tracking.

---

## Part 3: Architecture Decisions

### Language Choice: TypeScript (Node.js)

**Rationale:**
- MCP SDK is TypeScript-first (Anthropic's reference implementation)
- The agent ecosystem is heavily JS/TS (Clawdbot, LangChain.js, Vercel AI SDK)
- Node 22+ has native TypeScript support (via --experimental-strip-types or tsx)
- Daemon management (child processes, IPC, streams) is mature in Node
- npm distribution means `npx agentd start` just works

**Alternatives considered:**
- Rust: better for the sandbox/runtime layer, but slower iteration and smaller contributor pool
- Python: dominant in ML/AI, but Node is better for daemon/server workloads
- Go: great for daemons, but MCP ecosystem is JS-first

**Hybrid approach:** Core daemon in TypeScript. Sandbox execution layer in Rust (for security-critical isolation). Python SDK for agent authors who prefer Python.

### API Surface: gRPC + REST + CLI

Agents talk to agentd over localhost. Three interfaces:

| Interface | Use Case | Protocol |
|-----------|----------|----------|
| CLI | Human operators, scripts | Subcommands → REST under the hood |
| REST/HTTP | Simple integrations, webhooks | JSON over HTTP, localhost:4700 |
| gRPC | High-performance agent SDKs | Protobuf, localhost:4701 |
| MCP | AI clients (Claude, Cursor) | JSON-RPC over stdio or SSE |

The REST API is the canonical interface. gRPC is a performance optimization for heavy agent workloads. The CLI is syntactic sugar over REST. MCP is how AI tools discover agentd.

### Storage: SQLite Everywhere

No Postgres. No Redis. No external dependencies. SQLite handles:
- Agent state (key-value)
- Session logs (append-only)
- Traces (structured events)
- Tool registry (catalog)
- Scheduler state (next run times, queue)

One file per agent (`~/.agentd/agents/<name>/state.db`) plus one global DB (`~/.agentd/agentd.db`). Backup is `cp`. Migration is schema versioning in the DB itself.

### Config: YAML + Convention

```
~/.agentd/
├── config.yaml          # global config (port, sandbox defaults, model keys)
├── agentd.db            # global state + traces
├── tools/               # manually added MCP server configs
│   └── github.json
├── agents/
│   ├── inbox-bot/
│   │   ├── agent.yaml   # agent definition
│   │   └── state.db     # agent-specific state
│   └── code-review/
│       ├── agent.yaml
│       └── state.db
└── logs/
    └── agentd.log
```

---

## Part 4: How It's Used (User Stories)

### Story 1: Developer installs agentd and runs a one-off agent

```bash
# Install
npm install -g agentd

# Start the daemon
agentd start

# Run a one-off command
agentd run --model anthropic/claude-sonnet-4-5 \
  --prompt "Find all TODO comments in this repo and create a summary" \
  --tools filesystem,git
```

Time from install to value: ~90 seconds.

### Story 2: Developer creates a persistent agent

```bash
# Create an agent from a template
agentd agents create daily-standup \
  --model anthropic/claude-sonnet-4-5 \
  --trigger "cron:0 9 * * 1-5" \
  --tools gmail,slack,filesystem \
  --prompt "Check my calendar, email, and Slack. Write a standup update."

# It runs every weekday at 9am. Check what it did:
agentd logs daily-standup
agentd trace daily-standup --last
```

### Story 3: Framework author integrates with agentd

```python
# pip install agentd-sdk

from agentd import AgentdClient

client = AgentdClient()  # connects to localhost:4700

# Use agentd's sandbox instead of building your own
result = client.sandbox.exec("python3 analyze.py", timeout=30)

# Use agentd's tools instead of managing MCP servers yourself
files = client.tools.call("filesystem.list", path="/Users/me/projects")

# Use agentd's state instead of building persistence
client.state.set("my-agent", "last_run", "2026-02-25")
```

### Story 4: Enterprise team deploys agentd on shared infra

```yaml
# config.yaml for a team deployment
daemon:
  bind: 0.0.0.0:4700      # expose on network
  auth:
    mode: token             # require auth
    tokens:
      - name: ci-bot
        token: ${CI_BOT_TOKEN}
        permissions: [sandbox, tools, state]
      - name: monitoring
        token: ${MON_TOKEN}
        permissions: [traces]  # read-only observability

sandbox:
  default: microvm           # stronger isolation for multi-user
  resource_limits:
    cpu: 2
    memory: 2048             # MB
    timeout: 300              # seconds
```

---

## Part 5: Use Cases (Where Emergence Happens)

These are the use cases you build for (first three) and the ones that emerge on their own (rest):

**Built for:**
1. Personal automation agents (inbox, calendar, file management)
2. Developer workflow agents (code review, CI/CD, dependency updates)
3. Agent framework infrastructure (LangGraph/CrewAI use agentd as their backend)

**Emergent (you don't build these — the community does):**
4. Trading bots that run on cron with persistent state
5. Content pipelines: ingest RSS → summarize → post to social
6. Home automation: agent watches sensor data, takes actions
7. Research agents: continuously crawl, index, and summarize papers
8. Multi-agent systems: agents that spawn and coordinate other agents
9. Self-improving agents: agents that modify their own prompts based on trace data
10. Agent marketplaces: share agent.yaml files like Docker images

The emergence comes from the combination of primitives. Sandboxing + scheduling + state + tools = any autonomous workflow anyone can imagine.

---

## Part 6: Team Structure & Workstreams

### The Team (5 people)

| Role | Owns | Skills Required |
|------|------|----------------|
| **Lead / Architect** | Daemon core, API design, system integration | Node.js, systems programming, API design |
| **Sandbox Engineer** | Container/microVM isolation, resource limits | Linux internals, containers, security |
| **Tools & MCP Engineer** | Tool registry, auto-discovery, MCP protocol | MCP SDK, JSON-RPC, service discovery |
| **State & Scheduler Engineer** | SQLite state, traces, cron, webhooks, event bus | Databases, scheduling systems, event-driven |
| **DevEx & SDK Engineer** | CLI, Python/JS SDKs, docs, templates, web dashboard | DX design, multiple languages, technical writing |

### Phase Plan

**Phase 0: Foundation (Weeks 1–2)**
- Set up monorepo (pnpm workspace, TypeScript, Vitest)
- Daemon skeleton: start/stop, PID file, config loading
- REST API scaffold with health check
- CI/CD pipeline (GitHub Actions)
- Design doc: API surface (OpenAPI spec + protobuf definitions)

**Phase 1: Core Primitives (Weeks 3–8)**
- Sandbox: L0 (process) + L1 (container) execution
- Tool Registry: MCP client, auto-discovery, built-in filesystem/shell tools
- State: SQLite store, per-agent DBs, key-value API
- Scheduler: cron triggers, webhook listener, CLI manual runs
- Observability: trace logging, `agentd logs` and `agentd trace` commands

**Phase 2: Developer Experience (Weeks 9–12)**
- CLI polish: `agentd agents create`, interactive setup wizard
- Python SDK: `pip install agentd-sdk`
- JavaScript/TypeScript SDK: `npm install @agentd/sdk`
- Agent templates: inbox-bot, code-reviewer, daily-summary
- Documentation site (Mintlify or Docusaurus)
- `agentd doctor` diagnostic command

**Phase 3: Hardening & Community (Weeks 13–16)**
- L2 sandbox (Firecracker/gVisor)
- Web dashboard for traces and agent management
- Agent sharing: `agentd agents publish` / `agentd agents install`
- Cost tracking and alerts
- Security audit of sandbox isolation
- Open source launch: README, CONTRIBUTING, examples repo

---

## Part 7: Infrastructure & Costs

### Development Infrastructure

| Item | What | Monthly Cost |
|------|------|-------------|
| Dev machines | 5× MacBook Pro M3/M4 (already owned, presumably) | $0 |
| CI/CD | GitHub Actions (free tier for open source) | $0 |
| Linux test server | Hetzner AX102 or similar (for container/microVM testing) | ~$80/month |
| Domain + DNS | agentd.dev or similar | ~$15/year |
| Docs hosting | Mintlify or Vercel (free tier) | $0 |
| NPM org | @agentd scope | $7/month |
| PyPI | agentd-sdk package | $0 |

**Total dev infra: ~$100/month**

### Model Access (for testing)

You do NOT need to train or host models. agentd is model-agnostic. Agents bring their own model API keys. But for testing:

| Provider | What | Monthly Cost |
|----------|------|-------------|
| Anthropic | API access for testing agent runs | ~$50–200/month |
| OpenAI | API access for compatibility testing | ~$50–100/month |
| Ollama | Local models for offline testing | $0 (runs on dev machines) |

**Total model costs: ~$100–300/month for the team**

### Hardware Requirements (for users)

agentd itself is lightweight. The daemon idles at ~30MB RAM, ~0.1% CPU.

| User Profile | Machine | Works? |
|-------------|---------|--------|
| Developer on Mac | MacBook Pro M1+ | Yes, fully |
| Developer on Linux | Any modern x86/ARM | Yes, fully (best microVM support) |
| Developer on Windows | WSL2 required | Yes, with WSL2 |
| Raspberry Pi | RPi 4/5 | Yes, L0 sandbox only |
| Cloud VPS | $5/month Hetzner/DigitalOcean | Yes, fully |

**No GPU required.** agentd doesn't run models — it calls model APIs. If the user wants local models, they run Ollama separately and agentd talks to it.

### Production/Scaling Costs (Future)

If you eventually offer a hosted version (agentd Cloud):

| Scale | Infra | Monthly Cost |
|-------|-------|-------------|
| 100 users | 2× Hetzner AX52 | ~$200/month |
| 1,000 users | 5× dedicated + Firecracker fleet | ~$2,000/month |
| 10,000 users | Kubernetes cluster | ~$10,000/month |

But this is premature. Start local-first. Hosted is a monetization play for later.

---

## Part 8: What You Don't Build

Equally important — things that are out of scope:

| Don't Build | Why | Use Instead |
|-------------|-----|-------------|
| An LLM | You're a runtime, not a model provider | Anthropic, OpenAI, Ollama APIs |
| A framework | Frameworks are userland; you're infrastructure | Let LangGraph, CrewAI etc. build on agentd |
| A chat UI | You're headless; UIs are someone else's job | CLI + API; community builds UIs |
| A cloud platform | Start local; cloud is a monetization layer for later | User's own machine |
| MCP servers | You consume MCP servers, you don't build all of them | Community + existing ecosystem |
| An agent marketplace | Build the publish/install primitive; community builds the marketplace | GitHub, npm |

---

## Part 9: Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| MCP standard changes breaking your tool layer | High | Pin to MCP spec version, abstract behind internal interface |
| Docker/container dependency turns off casual users | Medium | L0 (process sandbox) works without Docker; container is opt-in |
| Anthropic/OpenAI build this themselves | High | Stay local-first and model-agnostic — they won't build the vendor-neutral version |
| Security vulnerability in sandbox | Critical | Hire a security auditor before launch; use established isolation (gVisor) not custom |
| Goose (Block) pivots from framework to runtime | Medium | Move fast; Goose is framework-shaped and backed by a big company (slow) |
| Adoption stalls — "just use Docker + cron" | Medium | DevEx is the moat. The person who makes it 10x easier than DIY wins |

---

## Part 10: The One-Line Pitch (For Each Audience)

**Developers:** "npm install -g agentd. Now every AI agent you write has sandboxing, persistence, scheduling, and tools — out of the box."

**Framework authors:** "Stop reinventing infrastructure. Build on agentd and ship features instead of plumbing."

**Investors:** "agentd is the runtime layer for AI agents. Every agent framework and every AI-powered app becomes a customer. Think Docker for autonomous AI."

**Hacker News:** "I got tired of every agent framework reimplementing sandboxing, state, and cron. So I built the layer underneath. `agentd start` — that's it."

---

## Part 11: Sequential Decision Checklist

Before writing code, resolve these in order:

1. **Name and namespace.** agentd? Something else? Secure the npm scope, PyPI package, domain, and GitHub org.
2. **License.** MIT (maximum adoption) or Apache 2.0 (patent protection). Recommendation: MIT.
3. **API spec.** Write the OpenAPI spec and protobuf definitions before any implementation. The API is the product.
4. **Sandbox strategy.** Confirm: L0 process + L1 Docker for MVP? Or ship L0-only to minimize dependencies?
5. **MCP version pin.** Which MCP spec version do you target? The 2025-03-26 spec is current.
6. **SDK priority.** TypeScript first (because the daemon is TS), Python second (because most agent authors use Python), or ship both simultaneously?
7. **Distribution.** npm global install? Homebrew? curl|sh? All three? Recommendation: npm first, Homebrew second.
8. **Telemetry.** Do you collect anonymous usage stats? Recommendation: opt-in only, privacy-first.
9. **Monetization model.** Open core (free runtime, paid cloud/enterprise features)? Pure open source with consulting? Decide before launch — it shapes architecture.
10. **Launch target.** What's the minimum viable demo? Recommendation: a 90-second video showing install → create agent → agent runs on cron → check traces.