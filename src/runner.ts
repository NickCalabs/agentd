import Anthropic from "@anthropic-ai/sdk";
import { loadApiKey } from "./config.ts";
import { getAgent } from "./agents.ts";
import { listTools, callTool } from "./tools/registry.ts";
import type { RegisteredTool } from "./tools/registry.ts";

export interface RunResult {
  agentName: string;
  output: string;
  toolCalls: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export function toAnthropicName(name: string): string {
  return name.replaceAll(".", "__");
}

export function fromAnthropicName(name: string): string {
  return name.replaceAll("__", ".");
}

const MAX_ITERATIONS = 20;

export async function runAgent(agentName: string, context?: string): Promise<RunResult> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    throw new Error(
      "Anthropic API key not found. Set ANTHROPIC_API_KEY env var or add api_key to ~/.agentd/config.yaml",
    );
  }

  const agent = getAgent(agentName);
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found`);
  }

  const allTools = listTools();

  // Resolve tools from agent config
  const resolvedTools: RegisteredTool[] = [];
  for (const toolSpec of agent.tools) {
    if (toolSpec.includes(".")) {
      const match = allTools.find((t) => t.name === toolSpec);
      if (match) resolvedTools.push(match);
    } else {
      // Server name — include all tools from that server
      resolvedTools.push(...allTools.filter((t) => t.serverName === toolSpec));
    }
  }

  // Map to Anthropic tool format
  const anthropicTools: Anthropic.Tool[] = resolvedTools.map((t) => ({
    name: toAnthropicName(t.name),
    description: t.description ?? "",
    input_schema: (t.inputSchema as Anthropic.Tool.InputSchema) ?? { type: "object" as const, properties: {} },
  }));

  const client = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = [];
  if (context) {
    messages.push({ role: "user", content: context });
  } else {
    messages.push({ role: "user", content: "Go." });
  }

  const startedAt = new Date().toISOString();
  const start = Date.now();
  let totalToolCalls = 0;
  let output = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`[runner] LLM call ${i + 1} for agent "${agentName}"`);

    const response = await client.messages.create({
      model: agent.model,
      max_tokens: 4096,
      system: agent.prompt,
      messages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      // Extract text blocks as final output
      const textParts = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text);
      output = textParts.join("\n");
      if (response.stop_reason === "max_tokens") {
        output += "\n[warning: response truncated due to max_tokens]";
      }
      break;
    }

    if (response.stop_reason === "tool_use") {
      // Append assistant message
      messages.push({ role: "assistant", content: response.content });

      // Process tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        totalToolCalls++;
        const originalName = fromAnthropicName(block.name);
        console.log(`[runner] Tool call: ${originalName}`);

        try {
          const result = await callTool(originalName, block.input as Record<string, unknown>);
          const mcpResult = result as { content?: unknown[]; isError?: boolean };

          if (mcpResult.isError) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: JSON.stringify(mcpResult.content),
            });
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(mcpResult.content),
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
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

  const completedAt = new Date().toISOString();

  console.log(`[runner] Agent "${agentName}" completed with ${totalToolCalls} tool calls`);

  return {
    agentName,
    output,
    toolCalls: totalToolCalls,
    startedAt,
    completedAt,
    durationMs: Date.now() - start,
  };
}
