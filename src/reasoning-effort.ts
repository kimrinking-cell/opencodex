import type { OcxProviderConfig } from "./types";
import { modelInList } from "./types";

// Descriptions mirror the upstream bundled models.json canonical wording (openai/codex PR #31684).
export const CODEX_REASONING_LEVELS: { effort: string; description: string }[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
  { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
];

const CODEX_REASONING_ORDER = CODEX_REASONING_LEVELS.map(l => l.effort);
const CODEX_REASONING_SET = new Set(CODEX_REASONING_ORDER);

/**
 * TokenRouter's free Qwen3.8-Max route is not the same contract as Alibaba's
 * official `qwen3.8-max`. The provider advertises Qwen's named low/medium/xhigh
 * ladder, with the upstream default represented by an omitted effort field.
 * Keep this policy at the shared reasoning boundary, but require BOTH provider
 * identity and the exact native model id: another provider may expose the same
 * model name with a different wire contract.
 */
const TOKENROUTER_PROVIDER_NAME = "tokenrouter";
const TOKENROUTER_BASE_URL = "https://api.tokenrouter.com/v1";
const TOKENROUTER_QWEN38_MAX_FREE_MODEL_ID = "qwen/qwen3.8-max-free";
export const TOKENROUTER_QWEN38_MAX_FREE_REASONING_EFFORTS = ["low", "medium", "xhigh"] as const;
export const TOKENROUTER_QWEN38_MAX_FREE_DEFAULT_REASONING_EFFORT = "xhigh" as const;

type TokenRouterProviderIdentity = Pick<OcxProviderConfig, "baseUrl"> | string | undefined;

function normalizedProviderBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return undefined;
  }
}

function isTokenRouterProvider(identity: TokenRouterProviderIdentity): boolean {
  if (typeof identity === "string") {
    return identity.trim().toLowerCase() === TOKENROUTER_PROVIDER_NAME;
  }
  return identity !== undefined
    && normalizedProviderBaseUrl(identity.baseUrl) === normalizedProviderBaseUrl(TOKENROUTER_BASE_URL);
}

/** Exact provider + native model guard used by catalog and adapter reasoning paths. */
export function isTokenRouterQwen38MaxFreeTarget(
  provider: TokenRouterProviderIdentity,
  modelId: string,
): boolean {
  return isTokenRouterProvider(provider) && modelId === TOKENROUTER_QWEN38_MAX_FREE_MODEL_ID;
}

/**
 * Compatibility overload: a model-only call is deliberately never a match.
 * Keeping that overload avoids making stale third-party callers fail to compile
 * while ensuring the special route can never become a global model-id exception.
 */
export function isTokenRouterQwen38MaxFreeModel(modelId: string): false;
export function isTokenRouterQwen38MaxFreeModel(provider: TokenRouterProviderIdentity, modelId: string): boolean;
export function isTokenRouterQwen38MaxFreeModel(
  providerOrModel: TokenRouterProviderIdentity,
  modelId?: string,
): boolean {
  if (modelId === undefined) return false;
  return isTokenRouterQwen38MaxFreeTarget(providerOrModel, modelId);
}

/** True when `effort` is a member of the Codex reasoning ladder (low..ultra). */
export function isCodexReasoningEffort(effort: string): boolean {
  return CODEX_REASONING_SET.has(effort);
}

/**
 * Reasoning ladder accepted for the OpenAI vision sidecar. `ultra` is deliberately excluded:
 * the vision describer is a single helper call, and `ultra` would be collapsed to `max` by the
 * upstream client boundary anyway.
 */
export const VISION_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type VisionReasoningEffort = typeof VISION_REASONING_EFFORTS[number];

/** True when `effort` is one of the vision sidecar's supported Responses reasoning levels. */
export function isVisionReasoningEffort(effort: unknown): effort is VisionReasoningEffort {
  return typeof effort === "string" && (VISION_REASONING_EFFORTS as readonly string[]).includes(effort);
}

/**
 * Normalize a persisted/configured vision reasoning value. Invalid values (hand-edited config,
 * stale files) degrade to `undefined` so the caller falls back to the documented default instead
 * of forwarding an upstream-rejected effort.
 */
export function sanitizeVisionReasoning(effort: unknown): VisionReasoningEffort | undefined {
  return isVisionReasoningEffort(effort) ? effort : undefined;
}

/** Position of `effort` in the Codex ladder (low=0 .. ultra=5), or -1 when not a ladder member. */
export function codexEffortRank(effort: string): number {
  return CODEX_REASONING_ORDER.indexOf(effort);
}

export function modelRecordValue<T>(record: Record<string, T> | undefined, modelId: string): T | undefined {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const colon = modelId.indexOf(":");
  if (colon > 0) {
    const family = modelId.slice(0, colon);
    if (Object.prototype.hasOwnProperty.call(record, family)) return record[family];
  }
  const folded = modelId.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === folded) return value;
  }
  return undefined;
}

export function sanitizeCodexReasoningEfforts(efforts: readonly string[] | undefined): string[] | undefined {
  if (efforts === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const effort of efforts) {
    if (!CODEX_REASONING_SET.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
  }
  return out.sort((a, b) => CODEX_REASONING_ORDER.indexOf(a) - CODEX_REASONING_ORDER.indexOf(b));
}

/**
 * Provider/model configured reasoning levels for the Codex catalog. `undefined` means “no override”,
 * while an empty array means “intentionally expose no effort control for this model”.
 */
export function configuredReasoningEfforts(provider: OcxProviderConfig, modelId: string): string[] | undefined {
  if (modelInList(provider.noReasoningModels, modelId)) return [];
  const modelEfforts = modelRecordValue(provider.modelReasoningEfforts, modelId);

  // Heal stale generated/configured metadata to the actual free-route ladder.
  // `noReasoningModels` remains the explicit opt-out; ordinary stale arrays do
  // not get to erase a known upstream capability.
  if (isTokenRouterQwen38MaxFreeTarget(provider, modelId)) {
    return [...TOKENROUTER_QWEN38_MAX_FREE_REASONING_EFFORTS];
  }

  if (modelEfforts !== undefined) return healMappedTiers(provider, modelId, sanitizeCodexReasoningEfforts(modelEfforts) ?? []);
  if (provider.reasoningEfforts !== undefined) return healMappedTiers(provider, modelId, sanitizeCodexReasoningEfforts(provider.reasoningEfforts) ?? []);
  return undefined;
}

/**
 * Resolve a catalog default after provider/model capability hints are known.
 * TokenRouter's free Qwen route defaults to the upstream named xhigh tier;
 * high/max/ultra are aliases for that top tier at the request boundary.
 */
export function configuredDefaultReasoningEffort(
  provider: OcxProviderConfig,
  modelId: string,
  fallback?: string,
): string | undefined {
  if (!isTokenRouterQwen38MaxFreeTarget(provider, modelId)) {
    return modelRecordValue(provider.modelDefaultReasoningEfforts, modelId) ?? fallback;
  }
  const supported = configuredReasoningEfforts(provider, modelId);
  if (supported !== undefined) return supported.length > 0
    ? TOKENROUTER_QWEN38_MAX_FREE_DEFAULT_REASONING_EFFORT
    : undefined;
  return fallback;
}

/**
 * Stale-ladder self-heal: a registry wire map is authoritative evidence of the upstream tiers
 * it can emit. Merge Codex-native map values into an older persisted ladder so newly documented
 * tiers appear without rewriting the user's config. Non-Codex values such as enabled/disabled
 * and Kimi's none sentinel are ignored here; they remain request-only wire aliases.
 */
function healMappedTiers(provider: OcxProviderConfig, modelId: string, efforts: string[]): string[] {
  if (efforts.length === 0) return efforts;
  const wireMap = reasoningEffortMapFor(provider, modelId);
  if (!wireMap) return efforts;
  const mappedTiers = Object.values(wireMap).filter(isCodexReasoningEffort);
  if (mappedTiers.length === 0) return efforts;
  return sanitizeCodexReasoningEfforts([...efforts, ...mappedTiers]) ?? efforts;
}

function requestToCodexEffort(requested: string): string | undefined {
  if (requested === "none") return undefined;
  if (requested === "minimal") return "low";
  return CODEX_REASONING_SET.has(requested) ? requested : undefined;
}

function clampToSupportedCodexEffort(requested: string, supported: readonly string[]): string | undefined {
  if (supported.length === 0) return undefined;
  const codex = requestToCodexEffort(requested);
  if (!codex) return undefined;
  if (supported.includes(codex)) return codex;

  const requestedRank = CODEX_REASONING_ORDER.indexOf(codex);
  let best = supported[0];
  let bestRank = CODEX_REASONING_ORDER.indexOf(best);
  for (const effort of supported) {
    const rank = CODEX_REASONING_ORDER.indexOf(effort);
    if (rank <= requestedRank && rank >= bestRank) {
      best = effort;
      bestRank = rank;
    }
  }
  // If every supported tier is above the requested tier, choose the lowest supported tier.
  return best;
}

export function reasoningEffortMapFor(provider: OcxProviderConfig, modelId: string): Record<string, string> | undefined {
  return modelRecordValue(provider.modelReasoningEffortMap, modelId) ?? provider.reasoningEffortMap;
}

/**
 * Translate Codex's reasoning label into the provider's real wire value. Prefer identity labels
 * (`xhigh` stays `xhigh`, `max` stays `max`); provider maps are only for real upstream aliases.
 */
export function mapReasoningEffort(provider: OcxProviderConfig, modelId: string, requested: string | undefined): string | undefined {
  if (modelInList(provider.noReasoningModels, modelId)) return undefined;

  // Qwen's xhigh is the provider default on this exact TokenRouter route. Its
  // upstream rejects a literal xhigh value, so all top-tier Codex aliases are
  // represented by an omitted field. `resolveReasoningEffort` supplies the
  // corresponding diagnostic metadata; this function remains the string-only
  // wire helper used by existing callers.
  if (isTokenRouterQwen38MaxFreeTarget(provider, modelId)) {
    if (!requested) return undefined;
    const codex = requestToCodexEffort(requested);
    if (codex === "xhigh" || codex === "high" || codex === "max" || codex === "ultra") return undefined;
    if (codex === "low" || codex === "medium") return codex;
    return undefined;
  }
  if (!requested) return undefined;

  // Upstream codex-rs converts ultra -> max before ANY provider request (core/src/client.rs
  // `reasoning_effort_for_request`), so "ultra" must never influence the provider wire — not even
  // through a raw alias. Apply the boundary before alias/clamp resolution.
  const boundary = requested === "ultra" ? "max" : requested;

  const wireMap = reasoningEffortMapFor(provider, modelId);
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, boundary)) return wireMap[boundary];

  const supported = configuredReasoningEfforts(provider, modelId);
  const codexEffort = supported !== undefined ? clampToSupportedCodexEffort(boundary, supported) : requestToCodexEffort(boundary);
  if (!codexEffort) return undefined;

  // Belt for the odd config where the supported ladder is ultra-only and the clamp lands on it.
  const wire = codexEffort === "ultra" ? "max" : codexEffort;
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, wire)) return wireMap[wire];
  return wire;
}

/** Exact outbound reasoning decision, including an intentional omitted field. */
export interface ReasoningEffortResolution {
  /** Caller intent; omitted when the caller left the effort unspecified. */
  requestedEffort?: string;
  /** Adapter-normalized/provider-effective tier shown in diagnostics. */
  effectiveEffort: string;
  /** Exact string value to put on the upstream wire, when one is emitted. */
  wireValue?: string;
  /** True when the named field must be omitted rather than sent with a value. */
  wireOmitted?: true;
}

export function resolveReasoningEffort(
  provider: OcxProviderConfig,
  modelId: string,
  requested: string | undefined,
): ReasoningEffortResolution | undefined {
  if (modelInList(provider.noReasoningModels, modelId)) return undefined;
  if (isTokenRouterQwen38MaxFreeTarget(provider, modelId)) {
    if (requested === undefined) {
      return {
        effectiveEffort: "provider-default/inferred-xhigh",
        wireOmitted: true,
      };
    }
    const codex = requestToCodexEffort(requested);
    if (codex === "xhigh" || codex === "high" || codex === "max" || codex === "ultra") {
      return {
        requestedEffort: requested,
        effectiveEffort: "xhigh",
        wireOmitted: true,
      };
    }
    if (codex === "low" || codex === "medium") {
      return { requestedEffort: requested, effectiveEffort: codex, wireValue: codex };
    }
    return undefined;
  }
  if (requested === undefined) return undefined;
  const wireValue = mapReasoningEffort(provider, modelId, requested);
  return wireValue === undefined
    ? undefined
    : { requestedEffort: requested, effectiveEffort: wireValue, wireValue };
}
