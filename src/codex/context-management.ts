import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Restore only metadata owned by this opt-in, including when the proxy is uninstalled. */
export function restoreGptContextManagement(models: RawEntry[]): boolean {
  let changed = false;
  for (const row of models) {
    if (!Object.hasOwn(row, CATALOG_MARKER)) continue;
    const messages = row.model_messages as Record<string, unknown> | undefined;
    if (messages && typeof messages === "object") {
      if (row[CATALOG_MARKER] === null) delete messages.token_budget;
      else messages.token_budget = row[CATALOG_MARKER];
    }
    delete row[CATALOG_MARKER];
    changed = true;
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
  /** Alternate accounts cannot ingest into the first account's backend session. */
  backendSessionId?: string;
  backendWindowOffset?: number;
}

function accountScopedId(value: string, identityHash: string): string {
  const bytes = Buffer.from(digest(`${identityHash}\0${value}`), "hex").subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Namespace backend ingestion without changing the client's task, agent names, or item IDs. */
export function applyContextAccountSession(
  owner: ContextAccountBinding, sourceHeaders: Headers, targetHeaders: Headers, body: unknown,
): void {
  if (!owner.backendSessionId) return;
  const source = JSON.parse(sourceHeaders.get("x-codex-turn-metadata") ?? "{}") as Record<string, unknown>;
  const identityKeys = ["thread_id", "parent_thread_id", "forked_from_thread_id", "turn_id", "parent_turn_id", "root_turn_id"];
  const update = (metadata: Record<string, unknown>) => {
    metadata.session_id = owner.backendSessionId;
    for (const key of identityKeys) {
      const value = boundedId(source[key]);
      if (value) metadata[key] = accountScopedId(value, owner.identityHash);
    }
    const window = boundedId(source.window_id);
    const windowNumber = typeof source.window_number === "number" && Number.isSafeInteger(source.window_number)
      ? source.window_number - (owner.backendWindowOffset ?? 0) : undefined;
    if (windowNumber !== undefined) metadata.window_number = windowNumber;
    if (window && typeof source.thread_id === "string" && window.startsWith(`${source.thread_id}:`)) {
      metadata.window_id = `${accountScopedId(source.thread_id, owner.identityHash)}:${windowNumber ?? window.slice(source.thread_id.length + 1)}`;
    }
  };
  const metadata = { ...source };
  update(metadata);
  targetHeaders.set("x-codex-turn-metadata", JSON.stringify(metadata));
  for (const key of ["session_id", "session-id"]) if (targetHeaders.has(key)) targetHeaders.set(key, owner.backendSessionId);
  for (const key of ["thread-id", "x-codex-parent-thread-id"]) {
    const value = sourceHeaders.get(key);
    if (value) targetHeaders.set(key, accountScopedId(value, owner.identityHash));
  }
  if (typeof metadata.window_id === "string") targetHeaders.set("x-codex-window-id", metadata.window_id);
  const raw = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
  const client = raw?.client_metadata;
  if (client && typeof client === "object" && !Array.isArray(client)) {
    const fields = client as Record<string, unknown>;
    update(fields);
    if (typeof fields["x-codex-turn-metadata"] === "string") {
      const full = JSON.parse(fields["x-codex-turn-metadata"]) as Record<string, unknown>;
      update(full);
      fields["x-codex-turn-metadata"] = JSON.stringify(full);
    }
    if (typeof metadata.window_id === "string") fields["x-codex-window-id"] = metadata.window_id;
  }
}

export function contextSessionDigest(sessionId: string): string {
  if (!boundedId(sessionId)) throw new Error("Invalid context-management session");
  return digest(sessionId);
}

function bindingPath(sessionId: string): string {
  return join(getConfigDir(), "context-management", `${contextSessionDigest(sessionId)}.json`);
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

/** The first owner keeps notes; every inference owner retains its own history segment. */
export function readContextHistoryAccounts(sessionId: string): ContextAccountBinding[] {
  const initial = readContextAccountBinding(sessionId);
  if (!initial) return [];
  const owners = new Map([[initial.identityHash, initial]]);
  const dir = join(getConfigDir(), "context-management", contextSessionDigest(sessionId));
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [initial];
    throw error;
  }
  if (names.length > 32) throw new Error("Too many context history accounts");
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Invalid context history account");
    const path = join(dir, name);
    if (statSync(path).size > 4096) throw new Error("Invalid context history account");
    const owner = JSON.parse(readFileSync(path, "utf8")) as ContextAccountBinding;
    if (owner.version !== 1 || owner.identityHash !== name.slice(0, -5)
      || !GPT_CONTEXT_MODELS.has(owner.model)
      || (owner.backendSessionId !== undefined && !boundedId(owner.backendSessionId))
      || (owner.kind === "pool" ? !boundedId(owner.accountId) : owner.kind !== "caller" || owner.accountId !== null)) {
      throw new Error("Invalid context history account");
    }
    if (!owners.has(owner.identityHash)) owners.set(owner.identityHash, owner);
  }
  return [...owners.values()];
}

/** Immutable first-writer records avoid losing concurrent account changes or storing tokens. */
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
    if (existing.identityHash !== binding.identityHash) {
      const owners = readContextHistoryAccounts(sessionId);
      const recorded = owners.find(owner => owner.identityHash === binding.identityHash);
      if (recorded) return recorded;
      binding.backendSessionId = accountScopedId(sessionId, binding.identityHash);
      const source = JSON.parse(headers.get("x-codex-turn-metadata") ?? "{}");
      if (Number.isSafeInteger(source.window_number) && source.window_number >= 0) binding.backendWindowOffset = source.window_number;
      if (!recorded) {
        if (owners.length >= 16) throw new Error("Too many context history accounts");
        const ownerDir = join(dir, contextSessionDigest(sessionId));
        mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
        try {
          writeFileSync(join(ownerDir, `${binding.identityHash}.json`), JSON.stringify(binding), { flag: "wx", mode: 0o600 });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        }
      }
      return binding;
    }
    return existing;
  }
  return binding;
}
