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

const PATHS = new Set([
  "alpha/history/v2/list_windows", "alpha/history/v2/list_items",
  "alpha/history/v2/read_item", "alpha/history/v2/search_contents",
  "alpha/notes/v2/thread_hint", "alpha/notes/v2/list_files_by_prefix",
  "alpha/notes/v2/read_file", "alpha/notes/v2/search_contents",
  "alpha/notes/v2/append_to_file", "alpha/notes/v2/write_file",
]);
export function isContextManagementPath(path: string): boolean {
  return path.startsWith("/v1/") && PATHS.has(path.slice(4));
}

export interface ContextRelayDependencies {
  resolveAuth?: typeof resolveCodexAuthContext;
  materializeAuth?: typeof materializeCodexUpstreamAuthAsync;
  fetch?: typeof fetch;
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
  let binding;
  try { binding = readContextAccountBinding(sessionId); }
  catch { return formatErrorResponse(409, "context_account_unavailable", "The original context account binding is unavailable"); }
  if (!binding) {
    // Codex requests this optional hint before its first model request supplies the model/account.
    // An empty hint is not a history lookup; every real operation needs the subsequent binding.
    if (path === "/v1/alpha/notes/v2/thread_hint") return Response.json({ text: "" });
    return formatErrorResponse(409, "context_account_unbound", "No GPT context request has established this session's account");
  }
  const linked = signalWithTimeout(35_000, req.signal);
  let auth: CodexAuthContext | undefined;
  let response: Response | undefined;
  let accountReady = false;
  try {
    auth = binding.kind === "caller" ? { kind: "main", accountId: null }
      : await (dependencies.resolveAuth ?? resolveCodexAuthContext)(req.headers, config, "pool", {
        accountId: binding.accountId!, modelId: binding.model,
        beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
        signal: linked.signal,
      });
    if (!isCodexAuthContextUsable(auth, config)) {
      return formatErrorResponse(401, "authentication_error", "The original context account needs authentication");
    }
    const headers = await (dependencies.materializeAuth ?? materializeCodexUpstreamAuthAsync)(req.headers, auth, { signal: linked.signal });
    assertContextAccountIdentity(binding, headers);
    accountReady = true;
    headers.set("content-type", "application/json");
    for (const name of ["x-openai-encrypted-tool-arguments", "x-openai-tool-output-truncation-policy"]) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const url = `${config.providers.openai!.baseUrl.replace(/\/+$/, "")}/${path.slice(4)}`;
    response = await (dependencies.fetch ?? fetch)(url, {
      method: "POST", headers, body: JSON.stringify(body), signal: linked.signal, redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      return formatErrorResponse(502, "upstream_error", "Context backend redirect was refused");
    }
    const observed = await readBoundedResponseBytes(response, { maxBytes: 4 * 1024 * 1024, signal: linked.signal });
    if (observed.oversized) return formatErrorResponse(502, "upstream_error", "Context backend response exceeded its size limit");
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return formatErrorResponse(502, "upstream_error", "Context backend did not return JSON");
    return new Response(observed.bytes, { status: response.status, headers: { "content-type": contentType, "cache-control": "no-store" } });
  } catch {
    if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Context request was canceled");
    if (linked.signal.aborted) return formatErrorResponse(504, "upstream_error", "Context backend timed out");
    if (accountReady) return formatErrorResponse(502, "upstream_error", "Context backend request failed");
    return formatErrorResponse(409, "context_account_unavailable", "Cannot use the original context account; restore it before continuing");
  } finally {
    if (auth) releaseCodexAuthContextProbeLease(auth);
    linked.cleanup();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}
