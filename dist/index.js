import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { start, stop, status } from "./daemon.js";
import { DEFAULT_PORT, DEFAULT_HOST, AGENTD_DIR } from "./config.js";
const BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const program = new Command();
program
    .name("agentd")
    .description("Universal agent runtime daemon")
    .version("0.1.0");
program
    .command("start")
    .description("Start the agentd daemon")
    .action(start);
program
    .command("stop")
    .description("Stop the agentd daemon")
    .action(stop);
program
    .command("status")
    .description("Show daemon status")
    .action(status);
program
    .command("run <agent-name>")
    .description("Run an agent")
    .option("--context <text>", "Context to pass to the agent")
    .action(async (agentName, opts) => {
    try {
        console.error(`Running ${agentName}...`);
        const res = await fetch(`${BASE_URL}/agents/${encodeURIComponent(agentName)}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: opts.context }),
        });
        if (!res.ok) {
            const body = (await res.json());
            console.error(`Error: ${body.error}`);
            process.exitCode = 1;
            return;
        }
        const result = (await res.json());
        console.log(result.output.trimEnd());
    }
    catch {
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
program
    .command("logs <agent-name>")
    .description("Show run history for an agent")
    .option("--limit <n>", "Number of runs to show", "20")
    .action(async (agentName, opts) => {
    try {
        const limit = Number(opts.limit) || 20;
        const res = await fetch(`${BASE_URL}/agents/${encodeURIComponent(agentName)}/runs?limit=${limit}`);
        const runs = (await res.json());
        if (runs.length === 0) {
            console.log(`No runs found for agent "${agentName}".`);
            return;
        }
        for (const r of runs) {
            const shortId = r.id.slice(0, 8);
            const duration = r.duration_ms != null ? formatDuration(r.duration_ms) : "-";
            const cost = `$${r.cost_usd.toFixed(3)}`;
            console.log(`${shortId}  ${r.started_at}  ${r.status}  ${duration}  ${r.tool_calls} tools  ${cost}`);
        }
    }
    catch {
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
program
    .command("trace <run-id>")
    .description("Show detailed trace for a run")
    .action(async (runId) => {
    try {
        const res = await fetch(`${BASE_URL}/runs/${encodeURIComponent(runId)}`);
        if (!res.ok) {
            const body = (await res.json());
            console.error(`Error: ${body.error}`);
            process.exitCode = 1;
            return;
        }
        const run = (await res.json());
        console.log(`Run #${run.id.slice(0, 8)} — ${run.agent_name} — ${run.started_at}`);
        const events = run.events ?? [];
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            const prefix = i === events.length - 1 ? "└─" : "├─";
            const d = e.data ?? {};
            if (e.type === "llm_call") {
                const model = stripModelDate(String(d.model ?? ""));
                const inTok = fmtNumber(Number(d.input_tokens ?? 0));
                const outTok = fmtNumber(Number(d.output_tokens ?? 0));
                const cost = costFromTokens(Number(d.input_tokens ?? 0), Number(d.output_tokens ?? 0));
                console.log(`${prefix} LLM call: ${model} (${inTok} in, ${outTok} out, $${cost})`);
            }
            else if (e.type === "tool_call") {
                const dur = formatDuration(Number(d.duration_ms ?? 0));
                const errFlag = d.is_error ? " [error]" : "";
                console.log(`${prefix} Tool call: ${d.tool} (${dur})${errFlag}`);
            }
            else if (e.type === "error") {
                console.log(`${prefix} Error: ${d.message}`);
            }
        }
        const totalDur = run.duration_ms != null ? formatDuration(run.duration_ms) : "-";
        console.log(`└─ Run complete — ${totalDur} — $${run.cost_usd.toFixed(3)}`);
    }
    catch {
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
program
    .command("costs")
    .description("Show cost summary across all agents")
    .action(async () => {
    try {
        const agentsRes = await fetch(`${BASE_URL}/agents`);
        const agentsList = (await agentsRes.json());
        if (agentsList.length === 0) {
            console.log("No agents registered.");
            return;
        }
        console.log("Agent\tRuns\tInput Tokens\tOutput Tokens\tCost");
        for (const a of agentsList) {
            const runsRes = await fetch(`${BASE_URL}/agents/${encodeURIComponent(a.name)}/runs?limit=10000`);
            const runs = (await runsRes.json());
            const totalIn = runs.reduce((s, r) => s + r.total_input_tokens, 0);
            const totalOut = runs.reduce((s, r) => s + r.total_output_tokens, 0);
            const totalCost = runs.reduce((s, r) => s + r.cost_usd, 0);
            console.log(`${a.name}\t${runs.length}\t${fmtNumber(totalIn)}\t${fmtNumber(totalOut)}\t$${totalCost.toFixed(3)}`);
        }
    }
    catch {
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
function formatNextRun(iso) {
    if (!iso)
        return "-";
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0)
        return "now";
    const sec = Math.floor(diff / 1000);
    if (sec < 60)
        return `in ${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60)
        return `in ${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24)
        return `in ${hr}h`;
    const days = Math.floor(hr / 24);
    return `in ${days}d`;
}
function stripModelDate(model) {
    return model.replace(/-\d{8}$/, "");
}
function fmtNumber(n) {
    return n.toLocaleString("en-US");
}
function costFromTokens(inputTokens, outputTokens) {
    // Approximate — matches the hardcoded pricing in traces.ts for known models
    const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
    return cost.toFixed(3);
}
const agents = program
    .command("agents")
    .description("Manage agents");
agents
    .command("list")
    .description("List registered agents")
    .action(async () => {
    try {
        const res = await fetch(`${BASE_URL}/agents`);
        const data = (await res.json());
        if (data.length === 0) {
            console.log("No agents registered.");
            return;
        }
        console.log("Name\tModel\tNext Run\tDescription");
        for (const a of data) {
            const nextRun = formatNextRun(a.next_run);
            console.log(`${a.name}\t${a.model}\t${nextRun}\t${a.description ?? ""}`);
        }
    }
    catch {
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
agents
    .command("add <name-or-path>")
    .description("Register an agent by name or YAML file path")
    .action(async (nameOrPath) => {
    try {
        // If it looks like a bare name (no slashes, no .yaml/.yml extension), resolve
        // to the conventional path: ~/.agentd/agents/<name>/agent.yaml
        let yamlPath;
        if (!nameOrPath.includes("/") && !nameOrPath.endsWith(".yaml") && !nameOrPath.endsWith(".yml")) {
            yamlPath = resolve(AGENTD_DIR, "agents", nameOrPath, "agent.yaml");
            if (!existsSync(yamlPath)) {
                console.error(`Agent YAML not found at ${yamlPath}`);
                console.error(`Create it with: mkdir -p ~/.agentd/agents/${nameOrPath} && edit that file`);
                process.exitCode = 1;
                return;
            }
        }
        else {
            yamlPath = resolve(nameOrPath);
        }
        const res = await fetch(`${BASE_URL}/agents`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ yamlPath }),
        });
        if (res.ok) {
            const agent = (await res.json());
            console.log(`Agent "${agent.name}" registered.`);
        }
        else {
            const body = (await res.json());
            console.error(`Error: ${body.error}`);
            process.exitCode = 1;
        }
    }
    catch {
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
agents
    .command("remove <name>")
    .description("Remove a registered agent")
    .action(async (name) => {
    try {
        const res = await fetch(`${BASE_URL}/agents/${encodeURIComponent(name)}`, {
            method: "DELETE",
        });
        if (res.status === 204) {
            console.log(`Agent "${name}" removed.`);
        }
        else {
            const body = (await res.json());
            console.error(`Error: ${body.error}`);
            process.exitCode = 1;
        }
    }
    catch {
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
const tools = program
    .command("tools")
    .description("Manage tools");
tools
    .command("list")
    .description("List available tools")
    .option("--verbose", "Show tab-separated detail format")
    .action(async (opts) => {
    try {
        const res = await fetch(`${BASE_URL}/tools`);
        const data = (await res.json());
        if (data.length === 0) {
            console.log("No tools available.");
            return;
        }
        if (opts.verbose) {
            console.log("Tool\tServer\tSource\tDescription");
            for (const t of data) {
                console.log(`${t.name}\t${t.serverName}\t${t.source ?? ""}\t${t.description ?? ""}`);
            }
            return;
        }
        // Grouped format
        const byServer = new Map();
        for (const t of data) {
            const entry = byServer.get(t.serverName);
            if (entry) {
                entry.tools.push(t.originalName);
            }
            else {
                byServer.set(t.serverName, { source: t.source ?? "", tools: [t.originalName] });
            }
        }
        console.log(`Tools — ${data.length} tools from ${byServer.size} servers`);
        for (const [server, info] of byServer) {
            const src = info.source ? ` (${info.source})` : "";
            console.log(`\n  ${server}${src} — ${info.tools.length} tools`);
            // Wrap tool names at ~76 chars
            let line = "    ";
            for (let i = 0; i < info.tools.length; i++) {
                const name = info.tools[i];
                const sep = i === 0 ? "" : ", ";
                if (line.length + sep.length + name.length > 76 && line.length > 4) {
                    console.log(line);
                    line = "    " + name;
                }
                else {
                    line += sep + name;
                }
            }
            if (line.length > 4)
                console.log(line);
        }
    }
    catch {
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
tools
    .command("add <package>")
    .description("Add an MCP tool server from an npm package")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (pkg, opts) => {
    // Derive server name: strip @scope/, strip server- prefix
    let name = pkg.replace(/^@[^/]+\//, "").replace(/^server-/, "");
    const command = "npx";
    const args = ["-y", pkg];
    if (!opts.yes) {
        console.log(`Will run: ${command} ${args.join(" ")}`);
        const answer = await promptUser("Proceed? [y/N] ");
        if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
            console.log("Aborted.");
            return;
        }
    }
    // Write config file
    const toolsDir = join(AGENTD_DIR, "tools");
    mkdirSync(toolsDir, { recursive: true });
    const configPath = join(toolsDir, `${name}.json`);
    const config = { mcpServers: { [name]: { command, args } } };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    // Register with daemon
    try {
        const res = await fetch(`${BASE_URL}/tools/servers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, config: { command, args }, confirmed: true }),
        });
        if (res.ok) {
            const body = (await res.json());
            console.log(`Added "${body.name}" — ${body.tools} tools: ${body.toolNames.join(", ")}`);
        }
        else {
            // Registration failed — remove config file
            unlinkSync(configPath);
            const body = (await res.json());
            console.error(`Error: ${body.error}`);
            process.exitCode = 1;
        }
    }
    catch {
        // Daemon unreachable — remove config file
        unlinkSync(configPath);
        console.error("Failed to reach daemon. Is the daemon running?");
        process.exitCode = 1;
    }
});
tools
    .command("remove <name>")
    .description("Remove an MCP tool server")
    .action(async (name) => {
    // Disconnect from daemon (lenient if daemon is down)
    try {
        const res = await fetch(`${BASE_URL}/tools/servers/${encodeURIComponent(name)}`, {
            method: "DELETE",
        });
        if (res.status === 204) {
            console.log(`Disconnected "${name}" from daemon.`);
        }
        else if (res.status === 404) {
            console.log(`Server "${name}" not found in daemon (may already be removed).`);
        }
    }
    catch {
        console.log(`Daemon not reachable — skipping disconnect.`);
    }
    // Delete config file
    const configPath = join(AGENTD_DIR, "tools", `${name}.json`);
    if (existsSync(configPath)) {
        unlinkSync(configPath);
        console.log(`Removed config: ${configPath}`);
    }
});
function promptUser(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
program.parse();
