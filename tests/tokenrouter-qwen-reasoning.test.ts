import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildCatalogEntries } from "../src/codex/catalog";
import { applyProviderConfigHints } from "../src/codex/catalog/provider-fetch";
import { recordAdapterReasoning, type RequestLogContext } from "../src/server/request-log";
import { normalizeUsageEntryForTest } from "../src/usage/log";
import {
  configuredDefaultReasoningEffort,
  configuredReasoningEfforts,
  isTokenRouterQwen38MaxFreeTarget,
  mapReasoningEffort,
  resolveReasoningEffort,
} from "../src/reasoning-effort";
import type { OcxProviderConfig } from "../src/types";

const TOKENROUTER_MODEL = "qwen/qwen3.8-max-free";

function staleTokenRouterProvider(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.tokenrouter.com/v1/",
    // This is the shape left by the earlier low/medium workaround. The shared
    // capability boundary must converge it to the real low/medium/xhigh ladder.
    modelReasoningEfforts: {
      [TOKENROUTER_MODEL]: ["low", "medium"],
    },
    modelDefaultReasoningEfforts: {
      [TOKENROUTER_MODEL]: "medium",
    },
    modelReasoningEffortMap: {
      [TOKENROUTER_MODEL]: {
        low: "low",
        medium: "medium",
        high: "medium",
        xhigh: "xhigh",
        max: "xhigh",
        ultra: "xhigh",
      },
    },
  };
}

function buildRequest(
  provider: OcxProviderConfig,
  modelId: string,
  reasoning?: string,
) {
  return createOpenAIChatAdapter(provider).buildRequest({
    modelId,
    context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
    stream: false,
    options: reasoning === undefined ? {} : { reasoning },
  });
}

function buildBody(provider: OcxProviderConfig, modelId: string, reasoning?: string): Record<string, unknown> {
  const request = buildRequest(provider, modelId, reasoning);
  return JSON.parse(String(request.body)) as Record<string, unknown>;
}

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

describe("TokenRouter Qwen3.8-Max free reasoning contract", () => {
  test("requires TokenRouter provider plus exact native model", () => {
    expect(isTokenRouterQwen38MaxFreeTarget("tokenrouter", TOKENROUTER_MODEL)).toBe(true);
    expect(isTokenRouterQwen38MaxFreeTarget("other-provider", TOKENROUTER_MODEL)).toBe(false);
    expect(isTokenRouterQwen38MaxFreeTarget("tokenrouter", "qwen-qwen3.8-max-free")).toBe(false);
  });

  test("keeps low/medium explicit and omits xhigh aliases with top-tier diagnostics", () => {
    const provider = staleTokenRouterProvider();

    expect(configuredReasoningEfforts(provider, TOKENROUTER_MODEL)).toEqual(["low", "medium", "xhigh"]);
    expect(configuredDefaultReasoningEffort(provider, TOKENROUTER_MODEL, "low")).toBe("xhigh");

    for (const requested of ["low", "medium"]) {
      const request = buildRequest(provider, TOKENROUTER_MODEL, requested);
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      expect(body.reasoning_effort, requested).toBe(requested);
      expect(request.reasoningLog).toMatchObject({
        effectiveEffort: requested,
        wireField: "reasoning_effort",
        wireValue: requested,
      });
      expect(request.reasoningLog?.wireOmitted).toBeUndefined();
    }

    for (const requested of ["xhigh", "high", "max", "ultra"]) {
      const request = buildRequest(provider, TOKENROUTER_MODEL, requested);
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(body, "reasoning_effort"), requested).toBe(false);
      expect(mapReasoningEffort(provider, TOKENROUTER_MODEL, requested), requested).toBeUndefined();
      expect(resolveReasoningEffort(provider, TOKENROUTER_MODEL, requested)).toEqual({
        requestedEffort: requested,
        effectiveEffort: "xhigh",
        wireOmitted: true,
      });
      expect(request.reasoningLog).toEqual({
        effectiveEffort: "xhigh",
        wireField: "reasoning_effort",
        wireOmitted: true,
      });

      const logCtx = {
        model: TOKENROUTER_MODEL,
        provider: "tokenrouter",
        requestedEffort: requested,
      } satisfies RequestLogContext;
      recordAdapterReasoning(logCtx, request);
      expect(logCtx.requestedEffort).toBe(requested);
      expect(logCtx.effectiveEffort).toBe("xhigh");
      expect(logCtx.reasoningWireField).toBe("reasoning_effort");
      expect(logCtx.reasoningWireOmitted).toBe(true);
      expect(logCtx.reasoningWireValue).toBeUndefined();
    }

    const persisted = normalizeUsageEntryForTest({
      requestId: "tokenrouter-omitted",
      timestamp: 1,
      provider: "tokenrouter",
      model: TOKENROUTER_MODEL,
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
      effectiveEffort: "xhigh",
      reasoningWireField: "reasoning_effort",
      reasoningWireOmitted: true,
    });
    expect(persisted.effectiveEffort).toBe("xhigh");
    expect(persisted.reasoningWireField).toBe("reasoning_effort");
    expect(persisted.reasoningWireOmitted).toBe(true);
    expect(persisted.reasoningWireValue).toBeUndefined();

    const defaultRequest = buildRequest(provider, TOKENROUTER_MODEL);
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(String(defaultRequest.body)), "reasoning_effort")).toBe(false);
    expect(defaultRequest.reasoningLog).toEqual({
      effectiveEffort: "provider-default/inferred-xhigh",
      wireField: "reasoning_effort",
      wireOmitted: true,
    });
  });

  test("catalog hints and serialized catalog converge to low/medium/xhigh with xhigh default", () => {
    const provider = staleTokenRouterProvider();
    const hinted = applyProviderConfigHints("tokenrouter", provider, {
      provider: "tokenrouter",
      id: TOKENROUTER_MODEL,
      reasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
    });

    expect(hinted.reasoningEfforts).toEqual(["low", "medium", "xhigh"]);
    expect(hinted.defaultReasoningEffort).toBe("xhigh");

    const entries = buildCatalogEntries(nativeTemplate(), [], [{
      provider: "tokenrouter",
      id: TOKENROUTER_MODEL,
      // Exercise the catalog's own exact provider/model guard as well as the
      // provider hint path: a stale live/cache row must not reintroduce mocks.
      reasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
    }]);
    const entry = entries.find(candidate => candidate.slug === "tokenrouter/qwen-qwen3.8-max-free");
    expect(entry).toBeTruthy();
    expect((entry?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "medium", "xhigh"]);
    expect(entry?.default_reasoning_level).toBe("xhigh");
  });

  test("Alibaba's official qwen3.8-max and the same model on another provider stay explicit", () => {
    const alibaba: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      modelReasoningEfforts: { "qwen3.8-max": ["low", "medium", "xhigh"] },
      modelDefaultReasoningEfforts: { "qwen3.8-max": "xhigh" },
    };
    expect(configuredReasoningEfforts(alibaba, "qwen3.8-max")).toEqual(["low", "medium", "xhigh"]);
    expect(configuredDefaultReasoningEffort(alibaba, "qwen3.8-max", "medium")).toBe("xhigh");
    expect(mapReasoningEffort(alibaba, "qwen3.8-max", "xhigh")).toBe("xhigh");
    expect(buildBody(alibaba, "qwen3.8-max", "xhigh").reasoning_effort).toBe("xhigh");

    const otherProvider: OcxProviderConfig = {
      ...staleTokenRouterProvider(),
      baseUrl: "https://other.example.test/v1",
    };
    expect(isTokenRouterQwen38MaxFreeTarget(otherProvider, TOKENROUTER_MODEL)).toBe(false);
    expect(mapReasoningEffort(otherProvider, TOKENROUTER_MODEL, "xhigh")).toBe("xhigh");
    expect(buildBody(otherProvider, TOKENROUTER_MODEL, "xhigh").reasoning_effort).toBe("xhigh");
  });
});
