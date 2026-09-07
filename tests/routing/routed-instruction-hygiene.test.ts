import { describe, expect, test } from "bun:test";
import { identifyRoutedModel, sanitizeRoutedInstructions } from "../../src/adapters/identity";
import { deriveEntry } from "../../src/codex/catalog/sync";
import { upstreamNativeEntry } from "../../src/codex/catalog/metadata";

describe("routed instruction hygiene", () => {
  test("routed catalog rows disable plugin and app usage layers", () => {
    const routed = deriveEntry(null, "qwen/qwen3.8-max-free", "Qwen", 1, {
      id: "qwen3.8-max-free", provider: "qwen",
    });
    expect(routed.include_plugin_usage_instructions).toBe(false);
    expect(routed.include_apps_usage_instructions).toBe(false);
  });

  test("canonical OpenAI forward aliases keep inherited flags", () => {
    const template = {
      slug: "gpt-5.6", display_name: "GPT-5.6", base_instructions: "native",
      include_plugin_usage_instructions: true, include_apps_usage_instructions: true,
    };
    const nativeAlias = deriveEntry(template, "openai/gpt-6-astra", "GPT", 1, {
      id: "gpt-6-astra", provider: "openai", codexForwardNativeCapabilityAlias: true,
    });
    const upstream = upstreamNativeEntry("gpt-6-astra");
    expect(nativeAlias.include_plugin_usage_instructions).toBe(upstream?.include_plugin_usage_instructions);
    expect(nativeAlias.include_apps_usage_instructions).toBe(upstream?.include_apps_usage_instructions);
  });

  test("routed sanitizer removes host cadence and tool commentary but preserves user prose", () => {
    const input = "Keep this user instruction.\nProvide updates every 60 seconds.\nSend commentary for each tool call.\n# Plugins\n# Apps";
    const out = sanitizeRoutedInstructions(input, "deepseek/deepseek-v4-flash");
    expect(out).toContain("Keep this user instruction.");
    expect(out).not.toMatch(/60 seconds|each tool call|# Plugins|# Apps/);
  });

  test("native GPT identity path is byte-stable when no identity line exists", () => {
    const input = "native text\n# Plugins\nProvide updates every 60 seconds.";
    expect(identifyRoutedModel(input, "gpt-5.6")).toBe(input);
  });
});
