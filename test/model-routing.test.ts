import { describe, it, expect } from "vitest";
import { parseModelProvider, toAnthropicName, fromAnthropicName } from "../src/runner.ts";
import { convertToolsToOllamaFormat, toOllamaToolName, fromOllamaToolName } from "../src/ollama.ts";
import type { RegisteredTool } from "../src/tools/registry.ts";

describe("parseModelProvider", () => {
  it("routes claude-* models to anthropic provider", () => {
    const result = parseModelProvider("claude-sonnet-4-20250514");
    expect(result).toEqual({ type: "anthropic", model: "claude-sonnet-4-20250514" });
  });

  it("routes claude-opus to anthropic provider", () => {
    const result = parseModelProvider("claude-opus-4-20250514");
    expect(result).toEqual({ type: "anthropic", model: "claude-opus-4-20250514" });
  });

  it("routes ollama/ models to ollama provider", () => {
    const result = parseModelProvider("ollama/llama3.3:70b");
    expect(result).toEqual({ type: "ollama", model: "llama3.3:70b" });
  });

  it("routes ollama/ models without tag", () => {
    const result = parseModelProvider("ollama/qwen3");
    expect(result).toEqual({ type: "ollama", model: "qwen3" });
  });

  it("routes ollama/ models with size tag", () => {
    const result = parseModelProvider("ollama/qwen3:32b");
    expect(result).toEqual({ type: "ollama", model: "qwen3:32b" });
  });

  it("rejects unknown model prefix with clear error", () => {
    expect(() => parseModelProvider("gpt-4o")).toThrow(
      'Unknown model "gpt-4o". Model must start with "claude-" or "ollama/"',
    );
  });

  it("rejects gemini models with clear error", () => {
    expect(() => parseModelProvider("gemini-pro")).toThrow('Unknown model "gemini-pro"');
  });

  it("rejects empty ollama model name", () => {
    expect(() => parseModelProvider("ollama/")).toThrow('missing model name after "ollama/"');
  });
});

describe("tool name conversion", () => {
  it("toAnthropicName converts dots to double underscores", () => {
    expect(toAnthropicName("filesystem.read_file")).toBe("filesystem__read_file");
  });

  it("fromAnthropicName converts double underscores to dots", () => {
    expect(fromAnthropicName("filesystem__read_file")).toBe("filesystem.read_file");
  });

  it("toOllamaToolName converts dots to double underscores", () => {
    expect(toOllamaToolName("filesystem.read_file")).toBe("filesystem__read_file");
  });

  it("fromOllamaToolName converts double underscores to dots", () => {
    expect(fromOllamaToolName("filesystem__read_file")).toBe("filesystem.read_file");
  });
});

describe("convertToolsToOllamaFormat", () => {
  it("converts RegisteredTool to OpenAI function calling format", () => {
    const tools: RegisteredTool[] = [
      {
        name: "filesystem.read_file",
        serverName: "filesystem",
        originalName: "read_file",
        description: "Read a file from the filesystem",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "The file path" },
          },
          required: ["path"],
        },
        source: "built-in",
      },
    ];

    const result = convertToolsToOllamaFormat(tools);
    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "filesystem__read_file",
          description: "Read a file from the filesystem",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "The file path" },
            },
            required: ["path"],
          },
        },
      },
    ]);
  });

  it("handles tools with no description or schema", () => {
    const tools: RegisteredTool[] = [
      {
        name: "server.my_tool",
        serverName: "server",
        originalName: "my_tool",
        source: "manual",
      },
    ];

    const result = convertToolsToOllamaFormat(tools);
    expect(result[0].function.description).toBe("");
    expect(result[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("converts multiple tools", () => {
    const tools: RegisteredTool[] = [
      {
        name: "fs.read",
        serverName: "fs",
        originalName: "read",
        description: "Read",
        inputSchema: { type: "object", properties: {} },
        source: "built-in",
      },
      {
        name: "fs.write",
        serverName: "fs",
        originalName: "write",
        description: "Write",
        inputSchema: { type: "object", properties: {} },
        source: "built-in",
      },
    ];

    const result = convertToolsToOllamaFormat(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe("fs__read");
    expect(result[1].function.name).toBe("fs__write");
  });
});
