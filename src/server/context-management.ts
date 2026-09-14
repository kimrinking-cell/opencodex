import { createHash } from "node:crypto";
import { formatErrorResponse } from "../bridge";
import {
  assertContextAccountIdentity, contextSessionFromBody, gptContextManagementEnabled,
  readContextAccountBinding,
} from "../codex/context-management";
import {
  isCodexAuthContextUsable, materializeCodexUpstreamAuthAsync,
  releaseCodexAuthContextProbeLease, resolveCodexAuthContext, type CodexAuthContext,
} from "../codex/auth-context";
import { signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import type { AdmissionLease } from "../lib/admission";
import type { OcxConfig } from "../types";
import { hasForwardableCodexBearer, validateForwardAdmissionCredential } from "./auth-cors";
import { codexAccountSelectionForTurn } from "./lifecycle";
import { readJsonRequestBody } from "./request-decompress";

const HISTORY_PATHS = new Set([
  "alpha/history/v2/list_windows", "alpha/history/v2/list_items",
  "alpha/history/v2/read_item", "alpha/history/v2/search_contents",
]);
const NOTES_PATHS = new Set([
  "alpha/notes/v2/thread_hint", "alpha/notes/v2/list_files_by_prefix",
  "alpha/notes/v2/read_file", "alpha/notes/v2/search_contents",
  "alpha/notes/v2/append_to_file", "alpha/notes/v2/write_file",
]);
const PATHS = new Set([...HISTORY_PATHS, ...NOTES_PATHS]);
export function isContextManagementPath(path: string): boolean {
  return path.startsWith("/v1/") && PATHS.has(path.slice(4));
}
export function isContextHistoryPath(path: string): boolean {
  return path.startsWith("/v1/") && HISTORY_PATHS.has(path.slice(4));
}

export interface ContextRelayDependencies {
  resolveAuth?: typeof resolveCodexAuthContext;
  materializeAuth?: typeof materializeCodexUpstreamAuthAsync;
  fetch?: typeof fetch;
  deadline?: typeof signalWithTimeout;
  observeFailure?: (event: ContextRelayFailure) => void;
}

/** Bounded operational metadata only; never backend text, headers, or note contents. */
export interface ContextRelayFailure {
  event: "context_relay_failure";
  operation: string;
  context_tag: string;
  phase: "resolve_auth" | "materialize_auth" | "upstream_headers" | "upstream_body";
  kind: "authentication" | "account_unavailable" | "client_canceled" | "deadline" | "transport" | "upstream_http" | "redirect" | "response_size" | "response_type";
  status: number;
  upstream_status: number | null;
  elapsed_ms: number;
  deadline_ms: number;
  client_aborted: boolean;
  relay_aborted: boolean;
  write_outcome: "not_applicable" | "not_sent" | "unknown";
}

/** Opaque native protocol: never log bodies, decrypt output, retry writes, or choose a new account. */
export async function handleContextManagement(
  req: Request, config: OcxConfig, turnAdmissionLease?: AdmissionLease,
  dependencies: ContextRelayDependencies = {},
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method !== "POST" || !isContextManagementPath(path) || !gptContextManagementEnabled(config)) {
    return formatErrorResponse(404, "not_found", "Context management is not enabled on this endpoint");
  }
  try { validateForwardAdmissionCredential(req.headers, config); }
  catch { return formatErrorResponse(401, "authentication_error", "Native ChatGPT authentication is required"); }
  if (!hasForwardableCodexBearer(req.headers, config)) {
    return formatErrorResponse(401, "authentication_error", "Native ChatGPT authentication is required");
  }
  let body: unknown;
  try { body = await readJsonRequestBody(req); }
  catch { return formatErrorResponse(400, "invalid_request_error", "Invalid context-management request body"); }
  const sessionId = contextSessionFromBody(body);
  if (!sessionId) return formatErrorResponse(400, "invalid_request_error", "A valid context session is required");
  if (isContextHistoryPath(path)) {
    return formatErrorResponse(
      404,
      "context_history_disabled",
      "Native History is not used for this session; recover conversation from local session records",
    );
  }
  let binding;
  try { binding = readContextAccountBinding(sessionId); }
  catch { return formatErrorResponse(409, "context_account_unavailable", "The original context account binding is unavailable"); }
  if (!binding) {
    // Codex requests this optional hint before its first model request supplies the model/account.
    // An empty hint is not a history lookup; every real operation needs the subsequent binding.
    if (path === "/v1/alpha/notes/v2/thread_hint") return Response.json({ text: "" });
    return formatErrorResponse(409, "context_account_unbound", "No GPT context request has established this session's account");
  }
  const started = performance.now();
  const linked = (dependencies.deadline ?? signalWithTimeout)(35_000, req.signal);
  let auth: CodexAuthContext | undefined;
  let response: Response | undefined;
  let accountReady = false;
  let phase: ContextRelayFailure["phase"] = "resolve_auth";
  let sent = false;
  const isWrite = path.endsWith("/append_to_file") || path.endsWith("/write_file");
  const observe = (kind: ContextRelayFailure["kind"], status: number) => {
    const event: ContextRelayFailure = {
      event: "context_relay_failure", operation: path.slice(4),
      context_tag: createHash("sha256").update(sessionId).digest("hex").slice(0, 16),
      phase, kind, status, upstream_status: response?.status ?? null,
      elapsed_ms: Math.round(performance.now() - started), deadline_ms: 35_000,
      // kind preserves the selected response mapping, not which deadline won a race.
      client_aborted: req.signal.aborted, relay_aborted: linked.signal.aborted,
      write_outcome: !isWrite ? "not_applicable" : sent ? "unknown" : "not_sent",
    };
    try {
      if (dependencies.observeFailure) dependencies.observeFailure(event);
      else console.warn(`[context-relay] ${JSON.stringify(event)}`);
    } catch { /* Diagnostics must never alter the opaque relay result. */ }
  };
  const failure = (status: number, code: string, message: string, kind: ContextRelayFailure["kind"]) => {
    observe(kind, status);
    return formatErrorResponse(status, code, message);
  };
  try {
    auth = binding.kind === "caller" ? { kind: "main", accountId: null }
      : await (dependencies.resolveAuth ?? resolveCodexAuthContext)(req.headers, config, "pool", {
        accountId: binding.accountId!, modelId: binding.model,
        beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
        ignoreQuotaCooldown: true,
        signal: linked.signal,
      });
    if (!isCodexAuthContextUsable(auth, config)) {
      return failure(401, "authentication_error", "The original context account needs authentication", "authentication");
    }
    phase = "materialize_auth";
    const headers = await (dependencies.materializeAuth ?? materializeCodexUpstreamAuthAsync)(req.headers, auth, { signal: linked.signal });
    assertContextAccountIdentity(binding, headers);
    accountReady = true;
    headers.set("content-type", "application/json");
    for (const name of ["x-openai-encrypted-tool-arguments", "x-openai-tool-output-truncation-policy"]) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const url = `${config.providers.openai!.baseUrl.replace(/\/+$/, "")}/${path.slice(4)}`;
    phase = "upstream_headers";
    sent = true;
    response = await (dependencies.fetch ?? fetch)(url, {
      method: "POST", headers, body: JSON.stringify(body), signal: linked.signal, redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      return failure(502, "upstream_error", "Context backend redirect was refused", "redirect");
    }
    phase = "upstream_body";
    const observed = await readBoundedResponseBytes(response, { maxBytes: 4 * 1024 * 1024, signal: linked.signal });
    if (observed.oversized) return failure(502, "upstream_error", "Context backend response exceeded its size limit", "response_size");
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return failure(502, "upstream_error", "Context backend did not return JSON", "response_type");
    if (!response.ok) observe("upstream_http", response.status);
    return new Response(observed.bytes, { status: response.status, headers: { "content-type": contentType, "cache-control": "no-store" } });
  } catch {
    if (req.signal.aborted) return failure(499, "client_closed_request", "Context request was canceled", "client_canceled");
    if (linked.signal.aborted) return failure(504, "upstream_error", "Context backend timed out", "deadline");
    if (accountReady) return failure(502, "upstream_error", "Context backend request failed", "transport");
    return failure(409, "context_account_unavailable", "Cannot use the original context account; restore it before continuing", "account_unavailable");
  } finally {
    if (auth) releaseCodexAuthContextProbeLease(auth);
    linked.cleanup();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}
