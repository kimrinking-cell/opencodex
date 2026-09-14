import type { OcxConfig, OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import type { CodexAuthContext } from "./auth-context";
import {
  bindContextAccount,
  contextAccountIdentity,
  contextSessionFromHeaders,
  GPT_CONTEXT_MODELS,
  LEGACY_CONTEXT_MODELS,
  readContextAccountBinding,
  type ContextAccountBinding,
} from "./context-management";
import { getMainAccountPlan } from "./main-account";
import { extractChatgptPlanType, codexPlanKey } from "./plan";

/** Plans whose ChatGPT backend actually serves native Notes for experimental context. */
const NOTES_OWNER_PLAN_KEYS = new Set(["plus", "pro", "pro_lite"]);

export interface ContextAccountSplitRequest {
  headers: Headers;
  modelId: string;
  providerName: string;
  provider: OcxProviderConfig;
}

/**
 * Native experimental-context turns (Sol/Astra Notes owners and Luna/Terra participants).
 * Names a trusted turn from route + ingest metadata, never a client-supplied flag.
 */
export function isNativeExperimentalContextRequest(args: ContextAccountSplitRequest): boolean {
  return (GPT_CONTEXT_MODELS.has(args.modelId) || LEGACY_CONTEXT_MODELS.has(args.modelId))
    && args.providerName === OPENAI_CODEX_PROVIDER_ID
    && isCanonicalOpenAiForwardProvider(args.provider)
    && contextSessionFromHeaders(args.headers) !== undefined;
}

/**
 * True when this attempt's ChatGPT serving identity is not the durable Notes owner.
 * Missing or unreadable identity fails closed (skip blob recovery) rather than throwing 409.
 */
export function contextServingIdentitySplit(sessionId: string, servingHeaders: Headers): boolean {
  try {
    const binding = readContextAccountBinding(sessionId);
    if (!binding) return false;
    return binding.identityHash !== contextAccountIdentity(servingHeaders);
  } catch {
    return true;
  }
}

/** Recompute `_contextAccountSplit` from this attempt's materialized serving headers. */
export function applyContextAccountSplitFlag(
  parsed: { _contextNotesSessionId?: string; _contextAccountSplit?: boolean },
  servingHeaders?: Headers,
): void {
  const sessionId = parsed._contextNotesSessionId;
  if (!sessionId) {
    parsed._contextAccountSplit = undefined;
    return;
  }
  if (!servingHeaders) return;
  parsed._contextAccountSplit = contextServingIdentitySplit(sessionId, servingHeaders);
}

/** JWT plan first, then the configured pool/main label. Never a guessed Team/Plus identity. */
export function contextAccountCanOwnNotes(headers: Headers, configuredPlan?: string): boolean {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const plan = extractChatgptPlanType(undefined, bearer) ?? configuredPlan;
  const key = codexPlanKey(plan);
  return key !== undefined && NOTES_OWNER_PLAN_KEYS.has(key);
}

export function configuredPlanForContextOwner(
  config: Pick<OcxConfig, "codexAccounts">,
  auth: CodexAuthContext,
): string | undefined {
  if (auth.kind === "main") return getMainAccountPlan();
  return config.codexAccounts?.find(account => account.id === auth.accountId)?.plan;
}

/**
 * First Plus/Pro writer owns Notes. Later identities, including Team, may infer without
 * replacing that owner. Team/unknown plans never become the durable Notes account.
 */
export function ensureContextNotesOwner(
  sessionId: string,
  model: string,
  auth: CodexAuthContext,
  headers: Headers,
  substituteMainCredential = false,
  configuredPlan?: string,
): ContextAccountBinding | undefined {
  if (!GPT_CONTEXT_MODELS.has(model)) throw new Error("Unsupported context-management model");
  const existing = readContextAccountBinding(sessionId);
  // Sol and Astra share one Notes owner. A model-cycle into the other experimental
  // model must keep inferring; treating that as an account change 409'd live threads.
  if (existing) return existing;
  if (!contextAccountCanOwnNotes(headers, configuredPlan)) return undefined;
  try {
    return bindContextAccount(sessionId, model, auth, headers, substituteMainCredential);
  } catch (error) {
    const raced = readContextAccountBinding(sessionId);
    if (raced) return raced;
    throw error;
  }
}
