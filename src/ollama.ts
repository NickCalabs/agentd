import type { RegisteredTool } from "./tools/registry.ts";
import { callTool } from "./tools/registry.ts";
import { logEvent } from "./traces.ts";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_BASE_URL = `${OLLAMA_HOST}/v1`;
const OLLAMA_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// OpenAI-compatible types (minimal subset needed)

interface OllamaFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface OllamaTool {
  type: "function";
  function: OllamaFunction;
}

interface OllamaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

interface OllamaChoice {
  message: OllamaMessage;
  finish_reason: string;
}

interface OllamaUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OllamaChatResponse {
  choices: OllamaChoice[];
  usage?: OllamaUsage;
}

export function toOllamaToolName(name: string): string {
  // OpenAI format: only allows [a-zA-Z0-9_-], no dots
  return name.replaceAll(".", "__");
}

export function fromOllamaToolName(name: string): string {
  return name.replaceAll("__", ".");
}

export function convertToolsToOllamaFormat(tools: RegisteredTool[]): OllamaTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: toOllamaToolName(t.name),
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

interface OllamaRunResult {
  output: string;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

const MAX_ITERATIONS = 20;

export async function runOllamaLoop(opts: {
  model: string;
  systemPrompt: string;
  tools: OllamaTool[];
  resolvedTools: RegisteredTool[];
  initialMessage: string;
  runId: string;
  maxTokens: number;
}): Promise<OllamaRunResult> {
  const { model, systemPrompt, tools, runId, maxTokens } = opts;

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.initialMessage },
  ];

  let totalToolCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let output = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const llmStart = Date.now();

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
    };
    if (tools.length > 0) {
      body.tools = tools;
    }

    let response: OllamaChatResponse;
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Ollama returned HTTP ${res.status}: ${text}`);
      }

      response = (await res.json()) as OllamaChatResponse;
    } catch (err: unknown) {
      if (err instanceof TypeError && (err as Error).message.includes("fetch")) {
        throw new Error(`Cannot reach Ollama at ${OLLAMA_HOST} — is it running?`);
      }
      // Connection refused / ECONNREFUSED
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        throw new Error(`Cannot reach Ollama at ${OLLAMA_HOST} — is it running?`);
      }
      throw err;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error("Ollama returned empty response (no choices)");
    }

    const usage = response.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    logEvent(runId, "llm_call", {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      stop_reason: choice.finish_reason,
      duration_ms: Date.now() - llmStart,
    });

    const assistantMsg = choice.message;
    const toolCalls = assistantMsg.tool_calls;

    // No tool calls — the model is done
    if (!toolCalls || toolCalls.length === 0) {
      output = assistantMsg.content ?? "";
      if (choice.finish_reason === "length") {
        output += "\n[warning: response truncated due to max_tokens]";
      }
      break;
    }

    // Has tool calls — process them
    messages.push({
      role: "assistant",
      content: assistantMsg.content,
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      totalToolCalls++;
      const originalName = fromOllamaToolName(tc.function.name);
      const toolStart = Date.now();

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      try {
        const result = await callTool(originalName, args);
        const mcpResult = result as { content?: unknown[]; isError?: boolean };

        logEvent(runId, "tool_call", {
          tool: originalName,
          args,
          result_preview: JSON.stringify(mcpResult.content).slice(0, 200),
          is_error: Boolean(mcpResult.isError),
          duration_ms: Date.now() - toolStart,
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(mcpResult.content),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        logEvent(runId, "tool_call", {
          tool: originalName,
          args,
          result_preview: msg.slice(0, 200),
          is_error: true,
          duration_ms: Date.now() - toolStart,
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: msg }),
        });
      }
    }
  }

  if (!output) {
    output = "[warning: agent reached maximum iteration limit (20) without producing a final response]";
  }

  return { output, totalToolCalls, totalInputTokens, totalOutputTokens };
}
