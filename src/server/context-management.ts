import { formatErrorResponse } from "../bridge";
import {
  assertContextAccountIdentity, contextSessionFromBody, gptContextManagementEnabled,
  readContextAccountBinding, readContextHistoryAccounts, contextAccountIdentity, applyContextAccountSession, type ContextAccountBinding,
} from "../codex/context-management";
import {
  isCodexContextStorageAuthUsable, materializeCodexUpstreamAuthAsync,
  releaseCodexAuthContextProbeLease, resolveCodexAuthContext, type CodexAuthContext,
} from "../codex/auth-context";
import { getCodexAccountCredential } from "../codex/account-store";
import { bundleContextHistoryOutputs } from "../codex/context-output-bundle";
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

/** Opaque native protocol: notes keep their owner; history reads cover all inference owners. */
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
  try {
    const owners = path.includes("/alpha/history/") ? readContextHistoryAccounts(sessionId) : [binding];
    if (owners.length === 1) {
      return await relayContextAccount(req, config, body, owners[0]!, linked.signal, turnAdmissionLease, dependencies);
    }
    // Bound fanout and total retained result bytes. Writes never enter this branch.
    const results: (Response | undefined)[] = new Array(owners.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, owners.length) }, async () => {
      while (next < owners.length) {
        const index = next++;
        results[index] = await relayContextAccount(req, config, body, owners[index]!, linked.signal, turnAdmissionLease, dependencies);
      }
    }));
    const outputs: string[] = [];
    const images: unknown[] = [];
    let unavailable = 0;
    let bytes = 0;
    for (const result of results) {
      // An account selected for an unsuccessful model attempt may never ingest history.
      if (result?.status === 404) continue;
      if (!result?.ok) { unavailable++; continue; }
      const text = await result.text();
      bytes += Buffer.byteLength(text);
      if (bytes > 8 * 1024 * 1024) throw new Error("Context history result exceeded the size limit");
      const value = JSON.parse(text) as { encrypted_output?: unknown; images?: unknown };
      if (typeof value.encrypted_output !== "string" || !value.encrypted_output) { unavailable++; continue; }
      outputs.push(value.encrypted_output);
      if (Array.isArray(value.images)) images.push(...value.images);
    }
    if (!outputs.length) return formatErrorResponse(502, "context_history_unavailable", "No context history storage segment could be read");
    return Response.json({
      encrypted_output: bundleContextHistoryOutputs(sessionId, outputs, unavailable),
      ...(images.length ? { images } : {}),
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Context request was canceled");
    if (linked.signal.aborted) return formatErrorResponse(504, "upstream_error", "Context backend timed out");
    return formatErrorResponse(502, "context_history_unavailable", "Context history storage could not be read completely");
  } finally { linked.cleanup(); }
}

async function relayContextAccount(
  req: Request, config: OcxConfig, body: unknown, binding: ContextAccountBinding,
  signal: AbortSignal, turnAdmissionLease: AdmissionLease | undefined, dependencies: ContextRelayDependencies,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  let auth: CodexAuthContext | undefined;
  let response: Response | undefined;
  let accountReady = false;
  try {
    let callerMatches = false;
    try { callerMatches = contextAccountIdentity(req.headers) === binding.identityHash; } catch {}
    // A Desktop login may change while old context remains. Locate only a saved,
    // configured credential with the original identity; never transfer the storage.
    let accountId = binding.kind === "pool" ? binding.accountId : undefined;
    if (binding.kind === "caller" && !callerMatches) {
      accountId = (config.codexAccounts ?? []).find(account => {
        if (account.isMain) return false;
        const credential = getCodexAccountCredential(account.id);
        if (!credential) return false;
        try {
          return contextAccountIdentity(new Headers({ authorization: `Bearer ${credential.accessToken}`, "chatgpt-account-id": credential.chatgptAccountId ?? "" })) === binding.identityHash;
        } catch { return false; }
      })?.id;
      if (!accountId) throw new Error("The original context credential is not available");
    }
    auth = binding.kind === "caller" && callerMatches ? { kind: "main", accountId: null }
      : await (dependencies.resolveAuth ?? resolveCodexAuthContext)(req.headers, config, "pool", {
        accountId: accountId!, contextStorageOnly: true,
        beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
        signal,
      });
    if (!isCodexContextStorageAuthUsable(auth, config)) {
      return formatErrorResponse(401, "authentication_error", "The original context account needs authentication");
    }
    const headers = await (dependencies.materializeAuth ?? materializeCodexUpstreamAuthAsync)(req.headers, auth, { signal });
    assertContextAccountIdentity(binding, headers);
    accountReady = true;
    headers.set("content-type", "application/json");
    for (const name of ["x-openai-encrypted-tool-arguments", "x-openai-tool-output-truncation-policy"]) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const url = `${config.providers.openai!.baseUrl.replace(/\/+$/, "")}/${path.slice(4)}`;
    const storageBody = binding.backendSessionId && body && typeof body === "object"
      ? { ...body, context: { ...(body as { context?: object }).context, session_id: binding.backendSessionId } }
      : body;
    applyContextAccountSession(binding, req.headers, headers, storageBody);
    response = await (dependencies.fetch ?? fetch)(url, {
      method: "POST", headers, body: JSON.stringify(storageBody), signal, redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      return formatErrorResponse(502, "upstream_error", "Context backend redirect was refused");
    }
    const observed = await readBoundedResponseBytes(response, { maxBytes: 4 * 1024 * 1024, signal });
    if (observed.oversized) return formatErrorResponse(502, "upstream_error", "Context backend response exceeded its size limit");
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return formatErrorResponse(502, "upstream_error", "Context backend did not return JSON");
    return new Response(observed.bytes, { status: response.status, headers: { "content-type": contentType, "cache-control": "no-store" } });
  } catch {
    if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Context request was canceled");
    if (signal.aborted) return formatErrorResponse(504, "upstream_error", "Context backend timed out");
    if (accountReady) return formatErrorResponse(502, "upstream_error", "Context backend request failed");
    return formatErrorResponse(409, "context_account_unavailable", "Cannot use the original context account; restore it before continuing");
  } finally {
    if (auth) releaseCodexAuthContextProbeLease(auth);
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}
