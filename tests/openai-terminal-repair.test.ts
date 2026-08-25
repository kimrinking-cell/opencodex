import { describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import {
  getProviderRegistryEntry,
  providerModelResponsesTerminalRepair,
} from "../src/providers/registry";
import { relaySseWithFailedTail } from "../src/server/relay";
import { relayResponsesSseWithTerminalRepair } from "../src/server/responses-terminal-repair";
import type { OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const encoder = new TextEncoder();

function openAiProvider(): OcxProviderConfig {
  return providerConfigSeed(getProviderRegistryEntry("openai")!);
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("OpenAI Sol missing-terminal repair", () => {
  test("is scoped to the canonical Sol forward route", () => {
    const provider = openAiProvider();
    expect(providerModelResponsesTerminalRepair("openai", provider, "gpt-5.6-sol"))
      .toEqual({ graceMs: 5_000 });
    expect(providerModelResponsesTerminalRepair("openai", provider, "gpt-5.6-terra"))
      .toBeUndefined();
    expect(providerModelResponsesTerminalRepair("custom-openai", provider, "gpt-5.6-sol"))
      .toBeUndefined();
  });

  test("promotes a clean EOF only after the output graph is structurally complete", async () => {
    const policy = providerModelResponsesTerminalRepair("openai", openAiProvider(), "gpt-5.6-sol");
    if (!policy) throw new Error("missing Sol terminal-repair policy");
    const body = [
      sse({
        type: "response.created",
        response: { id: "resp_sol", object: "response", status: "in_progress", output: [] },
        sequence_number: 0,
      }),
      sse({
        type: "response.output_item.added",
        item: { type: "message", id: "msg_sol", status: "in_progress", role: "assistant", content: [] },
        output_index: 0,
        sequence_number: 1,
      }),
      sse({
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "msg_sol",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
        output_index: 0,
        sequence_number: 2,
      }),
    ].join("");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    const upstream = new AbortController();
    const repaired = relaySseWithFailedTail(
      relayResponsesSseWithTerminalRepair(
        source,
        upstream,
        policy,
        createTestTranslatorBudget(),
      ),
      upstream,
    );

    const text = await new Response(repaired).text();
    expect(text).toContain("event: response.completed");
    expect(text).toContain('"status":"completed"');
    expect(text).not.toContain("response.incomplete");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});
