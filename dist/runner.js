import Anthropic from "@anthropic-ai/sdk";
import { loadApiKey } from "./config.js";
import { getAgent } from "./agents.js";
import { listTools, callTool } from "./tools/registry.js";
import { createRun, completeRun, failRun, logEvent, costForModel } from "./traces.js";
import { convertToolsToOllamaFormat, runOllamaLoop } from "./ollama.js";
const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const MAX_TOKENS = 8192;
export function parseModelProvider(model) {
    if (model.startsWith("claude-")) {
        return { type: "anthropic", model };
    }
    if (model.startsWith("ollama/")) {
        const ollamaModel = model.slice("ollama/".length);
        if (!ollamaModel) {
            throw new Error(`Invalid model "${model}": missing model name after "ollama/"`);
        }
        return { type: "ollama", model: ollamaModel };
    }
    throw new Error(`Unknown model "${model}". Model must start with "claude-" or "ollama/" (e.g. "claude-sonnet-4-20250514", "ollama/llama3.3:70b")`);
}
function isTransientError(err) {
    if (err && typeof err === "object" && "status" in err) {
        const status = err.status;
        if (status === 429) {
            // Try to extract retry-after from headers
            let retryAfterMs = DEFAULT_RETRY_DELAY_MS;
            if ("headers" in err && err.headers && typeof err.headers === "object") {
                const headers = err.headers;
                const retryAfter = headers["retry-after"];
                if (retryAfter) {
                    const seconds = Number(retryAfter);
                    if (!isNaN(seconds) && seconds > 0) {
                        retryAfterMs = seconds * 1000;
                    }
                }
            }
            return { transient: true, retryAfterMs };
        }
        if (status === 500 || status === 502 || status === 503 || status === 529) {
            return { transient: true, retryAfterMs: 5_000 };
        }
    }
    return { transient: false };
}
export function toAnthropicName(name) {
    return name.replaceAll(".", "__");
}
export function fromAnthropicName(name) {
    return name.replaceAll("__", ".");
}
const MAX_ITERATIONS = 20;
function resolveTools(agent) {
    const allTools = listTools();
    const resolved = [];
    for (const toolSpec of agent.tools) {
        if (toolSpec.includes(".")) {
            const match = allTools.find((t) => t.name === toolSpec);
            if (match)
                resolved.push(match);
        }
        else {
            resolved.push(...allTools.filter((t) => t.serverName === toolSpec));
        }
    }
    return resolved;
}
async function runAnthropicLoop(opts) {
    const { apiKey, agent, resolvedTools, context, runId } = opts;
    const anthropicTools = resolvedTools.map((t) => ({
        name: toAnthropicName(t.name),
        description: t.description ?? "",
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
    }));
    const client = new Anthropic({ apiKey });
    const messages = [];
    if (context) {
        messages.push({ role: "user", content: context });
    }
    else {
        messages.push({ role: "user", content: "Go." });
    }
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let output = "";
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const llmStart = Date.now();
        let response;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                response = await client.messages.create({
                    model: agent.model,
                    max_tokens: MAX_TOKENS,
                    system: agent.prompt,
                    messages,
                    tools: anthropicTools.length > 0 ? anthropicTools : undefined,
                });
                break;
            }
            catch (err) {
                const { transient, retryAfterMs } = isTransientError(err);
                if (!transient || attempt === MAX_RETRIES) {
                    throw err;
                }
                const delayMs = retryAfterMs ?? DEFAULT_RETRY_DELAY_MS;
                const errMsg = err instanceof Error ? err.message : String(err);
                logEvent(runId, "retry", {
                    attempt: attempt + 1,
                    max_retries: MAX_RETRIES,
                    error: errMsg,
                    delay_ms: delayMs,
                });
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
        // response is guaranteed assigned — the loop either breaks or throws
        response = response;
        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
        logEvent(runId, "llm_call", {
            model: agent.model,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            stop_reason: response.stop_reason,
            duration_ms: Date.now() - llmStart,
        });
        if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
            const textParts = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text);
            output = textParts.join("\n");
            if (response.stop_reason === "max_tokens") {
                output += "\n[warning: response truncated due to max_tokens]";
            }
            break;
        }
        if (response.stop_reason === "tool_use") {
            messages.push({ role: "assistant", content: response.content });
            const toolResults = [];
            for (const block of response.content) {
                if (block.type !== "tool_use")
                    continue;
                totalToolCalls++;
                const originalName = fromAnthropicName(block.name);
                const toolStart = Date.now();
                try {
                    const result = await callTool(originalName, block.input);
                    const mcpResult = result;
                    logEvent(runId, "tool_call", {
                        tool: originalName,
                        args: block.input,
                        result_preview: JSON.stringify(mcpResult.content).slice(0, 200),
                        is_error: Boolean(mcpResult.isError),
                        duration_ms: Date.now() - toolStart,
                    });
                    if (mcpResult.isError) {
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            is_error: true,
                            content: JSON.stringify(mcpResult.content),
                        });
                    }
                    else {
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: JSON.stringify(mcpResult.content),
                        });
                    }
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logEvent(runId, "tool_call", {
                        tool: originalName,
                        args: block.input,
                        result_preview: msg.slice(0, 200),
                        is_error: true,
                        duration_ms: Date.now() - toolStart,
                    });
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        is_error: true,
                        content: msg,
                    });
                }
            }
            messages.push({ role: "user", content: toolResults });
            continue;
        }
    }
    if (!output) {
        output = "[warning: agent reached maximum iteration limit (20) without producing a final response]";
    }
    return { output, totalToolCalls, totalInputTokens, totalOutputTokens };
}
export async function runAgent(agentName, runId, context) {
    const agent = getAgent(agentName);
    if (!agent) {
        const msg = `Agent "${agentName}" not found`;
        logEvent(runId, "error", { message: msg });
        failRun(runId, { error: msg, durationMs: 0 });
        throw new Error(msg);
    }
    const provider = parseModelProvider(agent.model);
    const resolvedTools = resolveTools(agent);
    // Anthropic path requires an API key; Ollama does not
    if (provider.type === "anthropic") {
        const apiKey = loadApiKey();
        if (!apiKey) {
            const msg = "Anthropic API key not found. Set ANTHROPIC_API_KEY env var or add api_key to ~/.agentd/config.yaml";
            logEvent(runId, "error", { message: msg });
            failRun(runId, { error: msg, durationMs: 0 });
            throw new Error(msg);
        }
    }
    const startedAt = new Date().toISOString();
    const start = Date.now();
    try {
        let result;
        if (provider.type === "anthropic") {
            result = await runAnthropicLoop({
                apiKey: loadApiKey(),
                agent: { model: provider.model, prompt: agent.prompt },
                resolvedTools,
                context,
                runId,
            });
        }
        else {
            // provider.type === "ollama"
            const ollamaTools = convertToolsToOllamaFormat(resolvedTools);
            result = await runOllamaLoop({
                model: provider.model,
                systemPrompt: agent.prompt,
                tools: ollamaTools,
                resolvedTools,
                initialMessage: context ?? "Go.",
                runId,
                maxTokens: MAX_TOKENS,
            });
        }
        const durationMs = Date.now() - start;
        const costUsd = provider.type === "anthropic"
            ? costForModel(agent.model, result.totalInputTokens, result.totalOutputTokens)
            : 0;
        const completedAt = new Date().toISOString();
        completeRun(runId, {
            output: result.output,
            totalInputTokens: result.totalInputTokens,
            totalOutputTokens: result.totalOutputTokens,
            costUsd,
            toolCalls: result.totalToolCalls,
            durationMs,
        });
        return {
            runId,
            agentName,
            output: result.output,
            toolCalls: result.totalToolCalls,
            startedAt,
            completedAt,
            durationMs,
            costUsd,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        const durationMs = Date.now() - start;
        logEvent(runId, "error", { message: msg, stack });
        failRun(runId, { error: msg, durationMs });
        throw err;
    }
}
