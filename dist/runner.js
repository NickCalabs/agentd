import Anthropic from "@anthropic-ai/sdk";
import { loadApiKey } from "./config.js";
import { getAgent } from "./agents.js";
import { listTools, callTool } from "./tools/registry.js";
import { createRun, completeRun, failRun, logEvent, costForModel } from "./traces.js";
export function toAnthropicName(name) {
    return name.replaceAll(".", "__");
}
export function fromAnthropicName(name) {
    return name.replaceAll("__", ".");
}
const MAX_ITERATIONS = 20;
export async function runAgent(agentName, context) {
    const apiKey = loadApiKey();
    if (!apiKey) {
        throw new Error("Anthropic API key not found. Set ANTHROPIC_API_KEY env var or add api_key to ~/.agentd/config.yaml");
    }
    const agent = getAgent(agentName);
    if (!agent) {
        throw new Error(`Agent "${agentName}" not found`);
    }
    const allTools = listTools();
    // Resolve tools from agent config
    const resolvedTools = [];
    for (const toolSpec of agent.tools) {
        if (toolSpec.includes(".")) {
            const match = allTools.find((t) => t.name === toolSpec);
            if (match)
                resolvedTools.push(match);
        }
        else {
            // Server name — include all tools from that server
            resolvedTools.push(...allTools.filter((t) => t.serverName === toolSpec));
        }
    }
    // Map to Anthropic tool format
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
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const runId = createRun(agentName);
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let output = "";
    try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            const llmStart = Date.now();
            const response = await client.messages.create({
                model: agent.model,
                max_tokens: 4096,
                system: agent.prompt,
                messages,
                tools: anthropicTools.length > 0 ? anthropicTools : undefined,
            });
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
        const durationMs = Date.now() - start;
        const costUsd = costForModel(agent.model, totalInputTokens, totalOutputTokens);
        const completedAt = new Date().toISOString();
        completeRun(runId, {
            output,
            totalInputTokens,
            totalOutputTokens,
            costUsd,
            toolCalls: totalToolCalls,
            durationMs,
        });
        return {
            runId,
            agentName,
            output,
            toolCalls: totalToolCalls,
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
