import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgent } from "../src/agents.ts";

const TMP = join(tmpdir(), "agentd-validation-test");

function writeYaml(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);
  return path;
}

describe("agent YAML validation", () => {
  mkdirSync(TMP, { recursive: true });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("rejects missing file with human-readable error", () => {
    expect(() => createAgent("/nonexistent/agent.yaml")).toThrow("File not found: /nonexistent/agent.yaml");
  });

  it("rejects directory path", () => {
    expect(() => createAgent(TMP)).toThrow("Path is a directory");
  });

  it("rejects invalid YAML syntax", () => {
    const path = writeYaml("bad-syntax.yaml", "name: foo\n  bad indent: bar\n:");
    expect(() => createAgent(path)).toThrow("Invalid YAML syntax");
  });

  it("rejects non-mapping YAML (array)", () => {
    const path = writeYaml("array.yaml", "- item1\n- item2\n");
    expect(() => createAgent(path)).toThrow("expected a mapping");
  });

  it("rejects non-mapping YAML (scalar)", () => {
    const path = writeYaml("scalar.yaml", "just a string\n");
    expect(() => createAgent(path)).toThrow("expected a mapping");
  });

  it("rejects missing name", () => {
    const path = writeYaml("no-name.yaml", "model: claude-sonnet-4-20250514\nprompt: hi\n");
    expect(() => createAgent(path)).toThrow("missing required field: name");
  });

  it("rejects missing model", () => {
    const path = writeYaml("no-model.yaml", "name: foo\nprompt: hi\n");
    expect(() => createAgent(path)).toThrow("missing required field: model");
  });

  it("rejects missing prompt", () => {
    const path = writeYaml("no-prompt.yaml", "name: foo\nmodel: claude-sonnet-4-20250514\n");
    expect(() => createAgent(path)).toThrow("missing required field: prompt");
  });

  it("rejects unknown model", () => {
    const path = writeYaml("bad-model.yaml", "name: foo\nmodel: gpt-4\nprompt: hi\n");
    expect(() => createAgent(path)).toThrow('Unknown model "gpt-4"');
  });

  it("rejects tools as a string", () => {
    const path = writeYaml("tools-string.yaml", "name: foo\nmodel: claude-sonnet-4-20250514\nprompt: hi\ntools: filesystem\n");
    expect(() => createAgent(path)).toThrow('"tools" must be an array');
  });

  it("rejects tools with non-string elements", () => {
    const path = writeYaml("tools-int.yaml", "name: foo\nmodel: claude-sonnet-4-20250514\nprompt: hi\ntools:\n  - 123\n");
    expect(() => createAgent(path)).toThrow('"tools[0]" must be a string');
  });

  it("rejects triggers as a number", () => {
    const path = writeYaml("triggers-num.yaml", "name: foo\nmodel: claude-sonnet-4-20250514\nprompt: hi\ntriggers: 42\n");
    expect(() => createAgent(path)).toThrow('"triggers" must be an array');
  });

  it("rejects non-string description", () => {
    const path = writeYaml("desc-num.yaml", "name: foo\nmodel: claude-sonnet-4-20250514\nprompt: hi\ndescription: 123\n");
    expect(() => createAgent(path)).toThrow('"description" must be a string');
  });

  it("rejects invalid cron expression", () => {
    const path = writeYaml("bad-cron.yaml", "name: bad-cron\nmodel: claude-sonnet-4-20250514\nprompt: hi\ntriggers:\n  - 'cron:not valid'\n");
    expect(() => createAgent(path)).toThrow("Invalid cron expression");
  });

  it("rejects unknown trigger type", () => {
    const path = writeYaml("bad-trigger.yaml", "name: bad-trigger\nmodel: claude-sonnet-4-20250514\nprompt: hi\ntriggers:\n  - 'webhook:http://example.com'\n");
    expect(() => createAgent(path)).toThrow('Unknown trigger type "webhook"');
  });

  it("rejects empty cron expression", () => {
    const path = writeYaml("empty-cron.yaml", "name: empty-cron\nmodel: claude-sonnet-4-20250514\nprompt: hi\ntriggers:\n  - 'cron:'\n");
    expect(() => createAgent(path)).toThrow("Empty cron expression");
  });
});
