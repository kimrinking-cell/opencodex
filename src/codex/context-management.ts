import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { extractAccountId } from "../oauth/chatgpt";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import type { OcxConfig } from "../types";
import type { CodexAuthContext } from "./auth-context";
import type { RawEntry } from "./catalog/parsing";
import { trustedAccountBoundNativeCatalogSlug } from "./catalog/account-models";
import upstreamModels from "./data/upstream-models.json";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { contextFailureReportGuidance, REPORT_MODELS } from "./context-failure-report";

/** Explicit native identities: a routed provider's GPT-shaped name is not eligible. */
export const GPT_CONTEXT_MODELS: ReadonlySet<string> = new Set(REPORT_MODELS);
export const LEGACY_CONTEXT_MODELS: ReadonlySet<string> = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);
const CATALOG_MARKER = "opencodex_context_management_original";
const CONTEXT_SUPPORT_MARKER = "opencodex_context_management_original_supports_experimental_context";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Restore only metadata owned by this opt-in, including when the proxy is uninstalled. */
export function restoreGptContextManagement(models: RawEntry[]): boolean {
  let changed = false;
  for (const row of models) {
    if (Object.hasOwn(row, CATALOG_MARKER)) {
      const messages = row.model_messages as Record<string, unknown> | undefined;
      if (messages && typeof messages === "object") {
        if (row[CATALOG_MARKER] === null) delete messages.token_budget;
        else messages.token_budget = row[CATALOG_MARKER];
      }
      delete row[CATALOG_MARKER];
      changed = true;
    }
    if (Object.hasOwn(row, CONTEXT_SUPPORT_MARKER)) {
      if (row[CONTEXT_SUPPORT_MARKER] === null) delete row.supports_experimental_context;
      else row.supports_experimental_context = row[CONTEXT_SUPPORT_MARKER];
      delete row[CONTEXT_SUPPORT_MARKER];
      changed = true;
    }
  }
  return changed;
}

export function gptContextManagementEnabled(config: Pick<OcxConfig, "gptContextManagement" | "providers">): boolean {
  const provider = config.providers.openai;
  return config.gptContextManagement === true && !!provider && provider.disabled !== true
    && isCanonicalOpenAiForwardProvider(provider);
}

export function contextSelfReportGuidance(model: string): string {
  return contextFailureReportGuidance(model, join(getConfigDir(), "context-failure-reports"));
}

/** Use Codex's model defaults, not a global flag which also activates routed models. */
export function applyGptContextManagement(models: RawEntry[], config: OcxConfig): void {
  const enabled = gptContextManagementEnabled(config);
  const source = (upstreamModels.models as RawEntry[]).find(row => row.slug === "gpt-6-astra");
  const sourceMessages = source?.model_messages as Record<string, unknown> | undefined;
  const defaults = sourceMessages?.token_budget as Record<string, unknown> | undefined;
  if (enabled && !defaults) throw new Error("Pinned native context-management guidance is unavailable");
  restoreGptContextManagement(models);
  for (const row of models) {
    const nativeSelector = trustedAccountBoundNativeCatalogSlug(row);
    const slug = nativeSelector ?? row.slug;
    if (row.opencodex_catalog_kind && !nativeSelector) continue;
    if (!enabled || typeof slug !== "string" || (!GPT_CONTEXT_MODELS.has(slug) && !LEGACY_CONTEXT_MODELS.has(slug))
      || typeof row.slug !== "string" || (row.slug.includes("/") && !nativeSelector)) continue;
    const own = row.model_messages && typeof row.model_messages === "object"
      ? row.model_messages as Record<string, unknown> : {};
    row[CATALOG_MARKER] = own.token_budget ?? null;
    const experimental = GPT_CONTEXT_MODELS.has(slug);
    row[CONTEXT_SUPPORT_MARKER] = Object.hasOwn(row, "supports_experimental_context")
      ? row.supports_experimental_context : null;
    row.supports_experimental_context = experimental;
    row.model_messages = { ...own, token_budget: {
      ...defaults,
      enabled: experimental,
      use_history_notes_extension: experimental,
      ...(experimental ? { guidance_message: `${defaults!.guidance_message}\n\n${contextSelfReportGuidance(slug)}` } : {}),
    } };
  }
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u0020\u007f]/.test(value) ? value : undefined;
}

/** Observed native 0.153 wire: the history-ingest marker is in turn metadata. */
export function contextSessionFromHeaders(headers: Headers): string | undefined {
  const raw = headers.get("x-codex-turn-metadata");
  if (!raw || raw.length > 16_384) return undefined;
  try {
    const metadata = JSON.parse(raw);
    return metadata?.history_ingest_requested === true ? boundedId(metadata.session_id) : undefined;
  } catch { return undefined; }
}

export function contextSessionFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  return boundedId((body as { context?: { session_id?: unknown } }).context?.session_id);
}

export interface ContextAccountBinding {
  version: 1;
  kind: "caller" | "pool";
  accountId: string | null;
  /** Stable account identity hash; never a bearer, raw account identifier, or note. */
  identityHash: string;
  model: string;
}

function bindingPath(sessionId: string): string {
  if (!boundedId(sessionId)) throw new Error("Invalid context-management session");
  return join(getConfigDir(), "context-management", `${digest(sessionId)}.json`);
}

export function readContextAccountBinding(sessionId: string): ContextAccountBinding | undefined {
  try {
    const path = bindingPath(sessionId);
    if (statSync(path).size > 4096) throw new Error("Invalid context-management binding");
    const text = readFileSync(path, "utf8");
    if (text.length > 4096) throw new Error("Invalid context-management binding");
    const value = JSON.parse(text) as ContextAccountBinding;
    if (value.version !== 1 || !["caller", "pool"].includes(value.kind)
      || !/^[a-f0-9]{64}$/.test(value.identityHash) || !GPT_CONTEXT_MODELS.has(value.model)
      || (value.kind === "pool" ? !boundedId(value.accountId) : value.accountId !== null)) {
      throw new Error("Invalid context-management binding");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Context-management account binding is unreadable; restore it before resuming this session");
  }
}

export function contextAccountIdentity(headers: Headers): string {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const identity = extractAccountId(undefined, bearer) ?? headers.get("chatgpt-account-id");
  if (!identity) throw new Error("Context management requires an identifiable ChatGPT account");
  return digest(identity);
}

export function assertContextAccountIdentity(binding: ContextAccountBinding, headers: Headers): void {
  if (binding.identityHash !== contextAccountIdentity(headers)) {
    throw new Error("This context belongs to another ChatGPT account; restore that account or start a new session");
  }
}

/** A first-writer claim survives proxy restarts. Concurrent different-account claims fail. */
export function bindContextAccount(
  sessionId: string, model: string, auth: CodexAuthContext, headers: Headers,
  substituteMainCredential = false,
): ContextAccountBinding {
  if (!GPT_CONTEXT_MODELS.has(model)) throw new Error("Unsupported context-management model");
  const binding: ContextAccountBinding = {
    version: 1,
    kind: auth.kind === "main" && !substituteMainCredential ? "caller" : "pool",
    accountId: auth.kind === "main" ? (substituteMainCredential ? MAIN_CODEX_ACCOUNT_ID : null) : auth.accountId,
    identityHash: contextAccountIdentity(headers), model,
  };
  const dir = join(getConfigDir(), "context-management");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { writeFileSync(bindingPath(sessionId), JSON.stringify(binding), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readContextAccountBinding(sessionId)!;
    assertContextAccountIdentity(existing, headers);
    if (existing.kind !== binding.kind || existing.accountId !== binding.accountId) {
      throw new Error("Context-management account selection changed; retry using the session's original account");
    }
    return existing;
  }
  return binding;
}
