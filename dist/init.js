import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { parse as parseYaml } from "yaml";
import { AGENTD_DIR, DEFAULT_HOST, DEFAULT_PORT } from "./config.js";
const BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const TEMPLATES = [
    { name: "code-auditor", label: "Code Auditor", desc: "Weekly security & code quality scan", placeholders: ["PROJECT_DIRS", "GITHUB_OWNER"] },
    { name: "dmg-cleaner", label: "DMG Cleaner", desc: "Daily cleanup of old downloads & temp files", placeholders: [] },
    { name: "repo-health", label: "Repo Health", desc: "Weekday check on uncommitted changes & stale branches", placeholders: ["PROJECT_DIRS"] },
    { name: "inbox-briefing", label: "Inbox Briefing", desc: "Twice-daily system & activity summary", placeholders: [] },
];
const SEARCH_DIRS = ["Documents/Projects", "Projects", "repos", "src", "code", "dev"];
function promptUser(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
export function resolveTemplatePath(name) {
    // import.meta.dirname points to src/ in dev, dist/ in built
    const dir = dirname(import.meta.dirname);
    return join(dir, "templates", "agents", `${name}.yaml`);
}
export function renderTemplate(content, vars) {
    let result = content;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{{${key}}}`, value);
    }
    return result;
}
export function detectGitRepos(searchDirs) {
    const home = homedir();
    const dirs = (searchDirs ?? SEARCH_DIRS).map((d) => join(home, d));
    const repos = [];
    for (const dir of dirs) {
        if (!existsSync(dir))
            continue;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = join(dir, entry);
            try {
                if (!statSync(full).isDirectory())
                    continue;
                if (existsSync(join(full, ".git"))) {
                    repos.push(full);
                }
            }
            catch {
                continue;
            }
        }
    }
    // Deduplicate by realpath
    const seen = new Set();
    return repos.filter((r) => {
        const resolved = resolve(r);
        if (seen.has(resolved))
            return false;
        seen.add(resolved);
        return true;
    });
}
export function detectGithubOwner() {
    // Try gh CLI first
    try {
        const result = execFileSync("gh", ["api", "user", "--jq", ".login"], {
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const login = result.trim();
        if (login)
            return login;
    }
    catch {
        // gh not installed or not authenticated
    }
    // Try parsing git remote from first repo found
    const repos = detectGitRepos();
    for (const repo of repos) {
        try {
            const remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
                encoding: "utf-8",
                timeout: 3000,
                stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            // SSH: git@github.com:OWNER/repo.git
            const sshMatch = remote.match(/github\.com[:/]([^/]+)\//);
            if (sshMatch)
                return sshMatch[1];
            // HTTPS: https://github.com/OWNER/repo.git
            const httpsMatch = remote.match(/github\.com\/([^/]+)\//);
            if (httpsMatch)
                return httpsMatch[1];
        }
        catch {
            continue;
        }
    }
    return null;
}
async function checkDaemonTools() {
    try {
        const res = await fetch(`${BASE_URL}/tools`);
        if (!res.ok)
            return null;
        const tools = (await res.json());
        const servers = new Set(tools.map((t) => t.serverName));
        return [...servers];
    }
    catch {
        return null;
    }
}
async function registerAgent(name) {
    const yamlPath = join(AGENTD_DIR, "agents", name, "agent.yaml");
    try {
        const res = await fetch(`${BASE_URL}/agents`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ yamlPath }),
        });
        if (res.ok) {
            return { ok: true, message: `Registered "${name}" with daemon` };
        }
        const body = (await res.json());
        if (body.error?.includes("already exists") || body.error?.includes("UNIQUE constraint")) {
            return { ok: true, message: `"${name}" already registered` };
        }
        return { ok: false, message: body.error };
    }
    catch {
        return { ok: false, message: "daemon not reachable" };
    }
}
export async function runInit() {
    console.log("agentd agent setup\n");
    // Step 1: Show template menu
    console.log("Available templates:");
    for (let i = 0; i < TEMPLATES.length; i++) {
        const t = TEMPLATES[i];
        console.log(`  ${i + 1}. ${t.label} — ${t.desc}`);
    }
    console.log();
    // Step 2: Get selection
    const input = await promptUser("Which agents? (comma-separated numbers, or 'all') [all]: ");
    let selected;
    if (!input || input.toLowerCase() === "all") {
        selected = [...TEMPLATES];
    }
    else {
        const indices = input.split(",").map((s) => parseInt(s.trim(), 10) - 1);
        selected = [];
        for (const idx of indices) {
            if (idx >= 0 && idx < TEMPLATES.length) {
                selected.push(TEMPLATES[idx]);
            }
            else {
                console.log(`Skipping invalid selection: ${idx + 1}`);
            }
        }
    }
    if (selected.length === 0) {
        console.log("No agents selected.");
        return;
    }
    // Step 3: Detect placeholders needed
    const needsProjectDirs = selected.some((t) => t.placeholders.includes("PROJECT_DIRS"));
    const needsGithubOwner = selected.some((t) => t.placeholders.includes("GITHUB_OWNER"));
    const vars = {};
    if (needsProjectDirs) {
        console.log("\nScanning for git repositories...");
        const repos = detectGitRepos();
        if (repos.length > 0) {
            console.log(`Found ${repos.length} repositories:`);
            for (const r of repos) {
                console.log(`  - ${r}`);
            }
            vars.PROJECT_DIRS = repos.map((r) => `  - ${r}`).join("\n");
        }
        else {
            console.log("No git repositories found in common locations.");
            vars.PROJECT_DIRS = "  # - /path/to/your/project  # Add your project directories here";
        }
    }
    if (needsGithubOwner) {
        console.log("\nDetecting GitHub username...");
        const owner = detectGithubOwner();
        if (owner) {
            console.log(`Found: ${owner}`);
            vars.GITHUB_OWNER = owner;
        }
        else {
            const entered = await promptUser("GitHub username (or press Enter to skip): ");
            vars.GITHUB_OWNER = entered || "YOUR_GITHUB_USERNAME";
        }
    }
    // Step 4: Check tool availability (best-effort)
    const availableServers = await checkDaemonTools();
    if (availableServers) {
        const needed = new Set(selected.flatMap((t) => {
            const path = resolveTemplatePath(t.name);
            const content = readFileSync(path, "utf-8");
            const parsed = parseYaml(content);
            return parsed.tools ?? [];
        }));
        const missing = [...needed].filter((t) => !availableServers.includes(t));
        if (missing.length > 0) {
            console.log(`\nNote: Some tools are not yet available: ${missing.join(", ")}`);
            console.log("You can add them later with: agentd tools add <package>");
        }
    }
    // Step 5: Write YAML files
    console.log();
    const written = [];
    const agentsDir = join(AGENTD_DIR, "agents");
    for (const t of selected) {
        const templatePath = resolveTemplatePath(t.name);
        if (!existsSync(templatePath)) {
            console.log(`Template not found: ${templatePath} — skipping`);
            continue;
        }
        const destDir = join(agentsDir, t.name);
        const destPath = join(destDir, "agent.yaml");
        if (existsSync(destPath)) {
            const answer = await promptUser(`${t.name}/agent.yaml already exists. Overwrite? [y/N]: `);
            if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
                console.log(`  Skipped ${t.name}`);
                continue;
            }
        }
        const raw = readFileSync(templatePath, "utf-8");
        const rendered = renderTemplate(raw, vars);
        mkdirSync(destDir, { recursive: true });
        writeFileSync(destPath, rendered, "utf-8");
        console.log(`  Wrote ${destPath}`);
        written.push(t.name);
    }
    if (written.length === 0) {
        console.log("No agents written.");
        return;
    }
    // Step 6: Register with daemon
    console.log();
    let daemonUp = true;
    for (const name of written) {
        const result = await registerAgent(name);
        if (result.ok) {
            console.log(`  ${result.message}`);
        }
        else if (result.message === "daemon not reachable") {
            daemonUp = false;
            break;
        }
        else {
            console.log(`  Failed to register "${name}": ${result.message}`);
        }
    }
    if (!daemonUp) {
        console.log("Daemon is not running. To activate your agents:");
        console.log("  agentd start");
        for (const name of written) {
            console.log(`  agentd agents add ${name}`);
        }
    }
    // Step 7: Summary
    console.log(`\nDone — ${written.length} agent${written.length === 1 ? "" : "s"} set up.`);
}
