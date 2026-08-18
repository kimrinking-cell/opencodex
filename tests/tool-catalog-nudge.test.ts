import { describe, expect, test } from "bun:test";
import {
  buildNonOpenAIToolCatalogNudgeForTools,
  buildNonOpenAIToolCatalogNudgeFromNames,
  shouldInjectNonOpenAIToolCatalogNudge,
} from "../src/adapters/tool-catalog-nudge";
import type { OcxTool } from "../src/types";

describe("non-OpenAI tool catalog nudge", () => {
  test("builds a compact catalog-grounding note from wire names", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(["exec_command", "mcp__fs__read_file"]);

    expect(note).toContain("current tool catalog as ground truth");
    expect(note).toContain("Valid tool names for this turn are exactly `exec_command`, `mcp__fs__read_file`");
    expect(note).toContain("do not invent, translate, or rename tools");
    expect(note).toContain("Count a tool call only after its tool result returns");
  });

  test("does not forbid neighboring tool names that are actually listed", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(["exec_command", "Glob"]);

    expect(note).toContain("`exec_command`, `Glob`");
    expect(note).toContain("`Read`, `Grep`, `Bash`, `LS`, `apply_patch`");
    expect(note).not.toContain("`Read`, `Grep`, `Glob`, `Bash`, `LS`, `apply_patch`");
  });

  test("explains Codex exec JavaScript when the catalog lists exec", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(["exec"]);

    expect(note).toContain("Valid tool names for this turn are exactly `exec`");
    expect(note).toContain("JavaScript program, not a shell line");
    expect(note).toContain("Do not write `exec_command --cmd`");
  });

  test("does not attach the exec JS contract when only exec_command is listed", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(["exec_command"]);
    expect(note).not.toContain("JavaScript program, not a shell line");
  });

  test("applies tool_choice before listing valid names", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
    ];

    const note = buildNonOpenAIToolCatalogNudgeForTools(tools, { mode: "required", allowedTools: ["mcp__fs__read_file"] });

    expect(note).toContain("`mcp__fs__read_file`");
    expect(note).not.toContain("`exec_command`,");
  });

  test("skips OpenAI and ChatGPT hosts", () => {
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://chatgpt.com/backend-api/codex" })).toBe(false);
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://api.kimi.com/coding/v1" })).toBe(true);
  });
});
