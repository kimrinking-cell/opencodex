import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGptContextManagement, applyContextAccountSession, bindContextAccount, contextSessionFromHeaders,
  GPT_CONTEXT_MODELS, LEGACY_CONTEXT_MODELS, readContextAccountBinding, readContextHistoryAccounts, restoreGptContextManagement,
} from "../src/codex/context-management";
import { bundleContextHistoryOutputs, expandContextHistoryOutputs } from "../src/codex/context-output-bundle";
import { handleCodexAuthAPI } from "../src/codex/auth-api";
import { recordCodexUpstreamOutcome, clearCodexAccountCooldown } from "../src/codex/routing";
import { markAccountNeedsReauth, clearAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { handleContextManagement, isContextManagementPath } from "../src/server/context-management";
import { handleResponses } from "../src/server/responses";
import { loadConfig, saveConfig, validateConfigCandidate } from "../src/config";
import { startServer } from "../src/server";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import type { CodexAuthContext } from "../src/codex/auth-context";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import type { OcxConfig } from "../src/types";
import type { RawEntry } from "../src/codex/catalog/parsing";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { handleManagementAPI, type ManagementApiDeps } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { startupHealthFixture } from "./helpers/startup-health";

let root: string;
let previousHome: string | undefined;
let config: OcxConfig;
let isolatedCodexHome: IsolatedCodexHome;
const authHeaders = (account = "fixture-account-a") => new Headers({
  authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: account })}`,
  "content-type": "application/json",
});
const headers = () => authHeaders();
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-gpt-context-"));
  process.env.OPENCODEX_HOME = root;
  isolatedCodexHome = installIsolatedCodexHome("ocx-context-native-");
  config = { ...loadConfig(), openaiProviderTierVersion: 2, defaultProvider: "openai", gptContextManagement: true, providers: {
    openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex" },
  } };
});
afterEach(() => {
  isolatedCodexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

const request = (operation = "alpha/history/v2/list_windows", body: unknown = { context: { session_id: "fixture-session", current_agent_name: "/root" }, limit: 1 }, h = headers()) =>
  new Request(`http://127.0.0.1/v1/${operation}`, { method: "POST", headers: h, body: JSON.stringify(body) });
function bind(account = "fixture-account-a") {
  return bindContextAccount("fixture-session", "gpt-5.6-sol", { kind: "main", accountId: null }, authHeaders(account));
}

function settings(body: unknown, deps: ManagementApiDeps) {
  const req = new ManagementRequest("http://127.0.0.1/api/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    getCachedStartupHealth: async () => startupHealthFixture(), ...deps,
  });
}

test("settings hot update persists the GPT-only opt-in and converges only when it changes", async () => {
  config.gptContextManagement = false;
  saveConfig(config);
  let convergences = 0;
  const deps = { createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences++; }) };
  for (const enabled of [true, true, false]) {
    const response = await settings({ gptContextManagement: enabled }, deps);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ gptContextManagement: enabled, catalogRefreshPending: false });
    expect(config.gptContextManagement).toBe(enabled);
    expect(loadConfig().gptContextManagement).toBe(enabled);
  }
  expect(convergences).toBe(2);
  expect((await settings({ gptContextManagement: "true" }, deps))?.status).toBe(400);
  expect(config.gptContextManagement).toBe(false);
});

test("failed settings persistence restores the live context flag", async () => {
  delete config.gptContextManagement;
  await expect(settings({ gptContextManagement: true }, {
    saveConfigPreservingClaudeCode: () => { throw new Error("fixture write failed"); },
  })).rejects.toThrow("fixture write failed");
  expect(Object.hasOwn(config, "gptContextManagement")).toBe(false);
});

describe("native GPT catalog opt-in", () => {
  test("Sol/Astra opt in with self-reporting; Luna/Terra remain legacy; routed names stay unchanged", () => {
    const experimental = [...GPT_CONTEXT_MODELS];
    const legacy = [...LEGACY_CONTEXT_MODELS];
    const rows = [...experimental, ...legacy].flatMap(slug => [
      { slug, experimental: experimental.includes(slug) },
      { slug: `account-a/${slug}`, experimental: experimental.includes(slug), account: true },
    ]);
    const models: RawEntry[] = rows.map(row => ({ slug: row.slug,
      ...(row.account ? { opencodex_catalog_kind: "account-selector-v1" } : {}),
      model_messages: { instructions_template: `native-${row.slug}` },
      supported_reasoning_levels: [{ effort: "high" }],
    }));
    models.push({ slug: "cursor/gpt-5.6-sol", model_messages: { instructions_template: "routed" } });
    models.push({ slug: "gpt-6-astra", opencodex_catalog_kind: "custom-model-v1", model_messages: { instructions_template: "custom" } });
    models.push({ slug: "claude-fable-5-1", model_messages: { instructions_template: "claude" } });
    const original = structuredClone(models);
    applyGptContextManagement(models, config);
    rows.forEach((row, i) => {
      const messages = models[i]!.model_messages as Record<string, any>;
      expect(messages.token_budget.enabled).toBe(row.experimental);
      expect(messages.token_budget.use_history_notes_extension).toBe(row.experimental);
      expect(messages.token_budget.guidance_message.includes("context-failure-report.ts")).toBe(row.experimental);
      if (row.experimental) expect(messages.token_budget.guidance_message).toContain("**컨텍스트 복구 문제 감지 — 미해결**");
      expect(messages.instructions_template).toBe((original[i]!.model_messages as Record<string, unknown>).instructions_template);
    });
    expect(models.slice(rows.length)).toEqual(original.slice(rows.length));
    const once = structuredClone(models);
    applyGptContextManagement(models, config);
    expect(models).toEqual(once);
    applyGptContextManagement(models, { ...config, gptContextManagement: false });
    expect(models).toEqual(original);
  });
  test("API-key OpenAI and malformed settings never enable the feature", () => {
    const models: RawEntry[] = [{ slug: "gpt-6-astra", model_messages: {} }];
    applyGptContextManagement(models, { ...config, providers: { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "fixture" } } });
    expect(models).toEqual([{ slug: "gpt-6-astra", model_messages: {} }]);
    const parsed = validateConfigCandidate({ ...config, gptContextManagement: "yes" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.gptContextManagement).toBeUndefined();
  });
  test("uninstall restores a pre-existing upstream token budget without consulting current config", () => {
    const models: RawEntry[] = [{ slug: "gpt-6-astra", model_messages: { token_budget: { enabled: false, guidance_message: "original" } } }];
    const original = structuredClone(models);
    applyGptContextManagement(models, config);
    expect(restoreGptContextManagement(models)).toBe(true);
    expect(models).toEqual(original);
    expect(restoreGptContextManagement(models)).toBe(false);
  });
});

test("only actual native history-ingest requests create a context session", () => {
  expect(contextSessionFromHeaders(new Headers({ "x-codex-window-id": "session:0" }))).toBeUndefined();
  expect(contextSessionFromHeaders(new Headers({ "x-codex-turn-metadata": JSON.stringify({ session_id: "fixture-session", history_ingest_requested: true }) }))).toBe("fixture-session");
  expect(contextSessionFromHeaders(new Headers({ "x-codex-turn-metadata": "not-json" }))).toBeUndefined();
});

test("persistent bindings preserve the note owner and record distinct history owners without credentials", () => {
  bind();
  expect(readContextAccountBinding("fixture-session")?.kind).toBe("caller");
  const file = join(root, "context-management", readdirSync(join(root, "context-management"))[0]!);
  const persisted = readFileSync(file, "utf8");
  expect(persisted).not.toContain("fixture-account-a");
  expect(persisted).not.toContain("Bearer");
  const original = readContextAccountBinding("fixture-session");
  bind("fixture-account-b");
  bind("fixture-account-b");
  expect(readContextAccountBinding("fixture-session")).toEqual(original);
  expect(readContextHistoryAccounts("fixture-session")).toHaveLength(2);
  expect(JSON.stringify(readContextHistoryAccounts("fixture-session"))).not.toContain("fixture-account");
});

test("endpoint allowlist excludes arbitrary backend paths and encoded variants", () => {
  expect(isContextManagementPath("/v1/alpha/notes/v2/write_file")).toBe(true);
  for (const path of ["/v1/alpha/notes/v2/delete_file", "/v1/alpha/notes/v2/read_file/", "/v1/alpha/notes/v2/read_file%2f", "/backend-api/codex/alpha/notes/v2/read_file"]) {
    expect(isContextManagementPath(path)).toBe(false);
  }
});

test("startup hint is empty before model selection; real operations cannot pick a random pool account", async () => {
  const hint = await handleContextManagement(request("alpha/notes/v2/thread_hint"), config);
  expect(hint.status).toBe(200);
  expect(await hint.json()).toEqual({ text: "" });
  expect((await handleContextManagement(request(), config)).status).toBe(409);
  expect((await handleContextManagement(request(), { ...config, gptContextManagement: false })).status).toBe(404);
  expect((await handleContextManagement(request(undefined, undefined, new Headers({ "content-type": "application/json" })), config)).status).toBe(401);
});

test("notes relay preserves encrypted arguments, context, truncation and opaque output", async () => {
  bind();
  const h = headers();
  h.set("x-openai-encrypted-tool-arguments", "true");
  h.set("x-openai-tool-output-truncation-policy", '{"bytes":4000}');
  const body = { context: { session_id: "fixture-session", current_agent_name: "/root" }, path: "checkpoint", content: "opaque-fixture" };
  let calls = 0;
  const response = await handleContextManagement(request("alpha/notes/v2/append_to_file", body, h), config, undefined, {
    fetch: (async (url: unknown, init?: RequestInit) => {
      calls++;
      expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/alpha/notes/v2/append_to_file");
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(init!.body as string)).toEqual(body);
      expect(new Headers(init?.headers).get("x-openai-encrypted-tool-arguments")).toBe("true");
      expect(new Headers(init?.headers).get("x-openai-tool-output-truncation-policy")).toBe('{"bytes":4000}');
      return Response.json({ encrypted_output: "opaque-result" });
    }) as typeof fetch,
  });
  expect(calls).toBe(1);
  expect(await response.json()).toEqual({ encrypted_output: "opaque-result" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("another account never reaches the backend", async () => {
  bind();
  let calls = 0;
  const response = await handleContextManagement(request(undefined, undefined, authHeaders("fixture-account-b")), config, undefined, {
    fetch: (async () => { calls++; return Response.json({}); }) as typeof fetch,
  });
  expect(response.status).toBe(409);
  expect(calls).toBe(0);
});

test("pool relay resolves the original added or main account explicitly and checks refreshed identity", async () => {
  const accessToken = fakeChatGptJwt({ chatgpt_account_id: "fixture-account-a" });
  writeFileSync(join(isolatedCodexHome.path, "auth.json"), JSON.stringify({ tokens: { access_token: accessToken, refresh_token: "fixture-refresh", account_id: "fixture-account-a" } }));
  config.codexAccounts = [{ id: "added-fixture", email: "fixture@example.test", isMain: false }];
  saveCodexAccountCredential("added-fixture", { accessToken, refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "fixture-account-a" });
  for (const accountId of ["added-fixture", MAIN_CODEX_ACCOUNT_ID]) {
    const sessionId = `session-${accountId}`;
    const auth: CodexAuthContext = { kind: "main-pool", accountId, writerGeneration: 1, accessToken: "fixture", chatgptAccountId: "fixture-account-a" };
    bindContextAccount(sessionId, "gpt-5.6-sol", auth, headers());
    let resolutions = 0;
    const response = await handleContextManagement(request(undefined, { context: { session_id: sessionId } }), config, undefined, {
      resolveAuth: async (_headers, _config, mode, options) => {
        resolutions++;
        expect(mode).toBe("pool");
        expect(options?.accountId).toBe(accountId);
        expect(options?.modelId).toBeUndefined();
        expect(options?.contextStorageOnly).toBe(true);
        return auth;
      },
      materializeAuth: async () => headers(),
      fetch: (async () => Response.json({ encrypted_output: "fixture" })) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(resolutions).toBe(1);
  }
});

test("actual HTTP listener admits the native hint but rejects a foreign browser origin", async () => {
  saveConfig({ ...config, port: 0, hostname: "127.0.0.1", codexAutoStart: false });
  const server = startServer(0);
  try {
    const url = `http://127.0.0.1:${server.port}/v1/alpha/notes/v2/thread_hint`;
    const body = JSON.stringify({ context: { session_id: "new-fixture", current_agent_name: "/root" } });
    const response = await fetch(url, { method: "POST", headers: headers(), body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "" });
    const foreign = headers(); foreign.set("origin", "https://unrelated.example.test");
    const rejected = await fetch(url, { method: "POST", headers: foreign, body });
    expect(rejected.status).toBe(403);
    await rejected.body?.cancel();
  } finally { await server.stop(true); }
});

test("writes are not replayed on redirects or backend failures and HTML is not success", async () => {
  bind();
  for (const upstream of [new Response(null, { status: 302, headers: { location: "https://example.invalid" } }), new Response("<html>", { headers: { "content-type": "text/html" } }), Response.json({ error: "temporary" }, { status: 503 })]) {
    let calls = 0;
    const response = await handleContextManagement(request("alpha/notes/v2/append_to_file"), config, undefined, {
      fetch: (async () => { calls++; return upstream; }) as typeof fetch,
    });
    expect(response.status).toBe(upstream.status === 503 ? 503 : 502);
    expect(calls).toBe(1);
  }
});

test("active context cannot switch into a routed provider", async () => {
  const h = headers();
  h.set("x-codex-turn-metadata", JSON.stringify({ session_id: "fixture-session", history_ingest_requested: true }));
  const routed = { ...config, providers: { ...config.providers, fixture: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, apiKey: "fixture", selectedModels: ["claude"], models: ["claude"] } } } as OcxConfig;
  const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: h, body: JSON.stringify({ model: "fixture/claude", input: "fixture", stream: false }),
  }), routed, { model: "fixture/claude", provider: "fixture" });
  const result = await response.json();
  expect(result.error.code).toBe("context_model_unsupported");
  expect(response.status).toBe(409);
});

test("actual Responses wire carries self-report guidance only in active Sol/Astra contexts", async () => {
  writeFileSync(join(isolatedCodexHome.path, "auth.json"), JSON.stringify({ tokens: { access_token: fakeChatGptJwt({ chatgpt_account_id: "fixture-account-a" }), refresh_token: "fixture-refresh", account_id: "fixture-account-a" } }));
  const originalFetch = globalThis.fetch;
  const captured: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/models")) return Response.json({ models: ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-terra"].map(slug => ({ slug, supported_in_api: true, visibility: "list" })) });
    captured.push(typeof init?.body === "string" ? init.body : "");
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    for (const model of ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-terra"]) {
      const experimental = GPT_CONTEXT_MODELS.has(model);
      const h = headers();
      if (experimental) h.set("x-codex-turn-metadata", JSON.stringify({ session_id: `fixture-${model}`, history_ingest_requested: true }));
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", headers: h, body: JSON.stringify({ model, input: [{ role: "user", content: "fixture" }], stream: true }),
      }), config, { model, provider: "openai" });
      if (response.status !== 200) throw new Error(`${model}: ${await response.text()}`);
      expect(response.status).toBe(200);
      await response.text();
      const wire = captured.at(-1)!;
      expect(wire).toContain(model);
      expect(wire.includes("context-failure-report.ts")).toBe(experimental);
      expect(wire.includes("**컨텍스트 복구 문제 감지 — 복구 완료**")).toBe(experimental);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("history fans out across recorded accounts and opaque results expand on the Responses wire", async () => {
  bind();
  bind("fixture-account-b");
  const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-account-b" });
  config.codexAccounts = [{ id: "pool-b", email: "fixture@example.test", isMain: false }];
  config.pausedCodexAccountIds = ["pool-b"];
  saveCodexAccountCredential("pool-b", { accessToken: token, refreshToken: "fixture", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "fixture-account-b" });
  const calls: string[] = [];
  const response = await handleContextManagement(request(), config, undefined, {
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const account = new Headers(init?.headers).get("chatgpt-account-id")!;
      calls.push(account);
      return Response.json({ encrypted_output: `ciphertext-${account}` });
    }) as typeof fetch,
  });
  expect(response.status).toBe(200);
  expect(calls.sort()).toEqual(["fixture-account-a", "fixture-account-b"]);
  const result = await response.json();
  const body = { input: [{ type: "function_call_output", output: [{ type: "encrypted_content", encrypted_content: result.encrypted_output }] }] };
  expandContextHistoryOutputs(body, "fixture-session");
  expect(body.input[0]!.output).toContainEqual({ type: "encrypted_content", encrypted_content: "ciphertext-fixture-account-a" });
  expect(body.input[0]!.output).toContainEqual({ type: "encrypted_content", encrypted_content: "ciphertext-fixture-account-b" });
  const wrong = { input: [{ type: "function_call_output", output: [{ type: "encrypted_content", encrypted_content: result.encrypted_output }] }] };
  expect(() => expandContextHistoryOutputs(wrong, "another-session")).toThrow("Invalid context history bundle");
  calls.length = 0;
  const notes = await handleContextManagement(request("alpha/notes/v2/write_file", { context: { session_id: "fixture-session", current_agent_name: "/root" }, path: "checkpoint", text: "encrypted-fixture" }), config, undefined, {
    fetch: (async (_url: unknown, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("chatgpt-account-id")!);
      return Response.json({ encrypted_output: "write-result" });
    }) as typeof fetch,
  });
  expect(notes.status).toBe(200);
  expect(calls).toEqual(["fixture-account-a"]);
});

test("manual selection changes actual inference account within the same context while retaining history", async () => {
  config.providers.openai!.codexAccountMode = "pool";
  config.codexAccounts = ["a", "b"].map(id => ({ id: `pool-${id}`, email: `${id}@example.test`, isMain: false }));
  for (const id of ["a", "b"]) saveCodexAccountCredential(`pool-${id}`, {
    accessToken: fakeChatGptJwt({ chatgpt_account_id: `fixture-account-${id}` }),
    refreshToken: "fixture", expiresAt: Date.now() + 3_600_000, chatgptAccountId: `fixture-account-${id}`,
  });
  config.activeCodexAccountId = "pool-a";
  config.activeCodexAccountPinned = "pool-a";
  const originalFetch = globalThis.fetch;
  const captured: { account: string | null; body: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/models")) return Response.json({ models: [{ slug: "gpt-5.6-sol", supported_in_api: true, visibility: "list" }] });
    captured.push({ account: new Headers(init?.headers).get("chatgpt-account-id"), body: String(init?.body) });
    return new Response('data: {"type":"response.completed","response":{"id":"fixture-response","status":"completed","output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const turn = async (bundle?: string) => {
    const h = headers();
    h.set("x-codex-turn-metadata", JSON.stringify({ session_id: "switch-session", history_ingest_requested: true }));
    const input: unknown[] = [{ role: "user", content: "fixture" }];
    if (bundle) input.push({ type: "function_call", name: "list_windows", call_id: "call-fixture", arguments: "{}" }, { type: "function_call_output", call_id: "call-fixture", output: [{ type: "encrypted_content", encrypted_content: bundle }] });
    const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: h, body: JSON.stringify({ model: "gpt-5.6-sol", input, stream: true }),
    }), config, { model: "gpt-5.6-sol", provider: "openai" });
    if (response.status !== 200) throw new Error(await response.text());
    await response.text();
  };
  try {
    await turn();
    expect(captured.at(-1)?.account).toBe("fixture-account-a");
    const select = new Request("http://localhost/api/codex-auth/active", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: "pool-b" }) });
    const switched = await handleCodexAuthAPI(select, new URL(select.url), config);
    expect(switched?.status).toBe(200);
    await turn(bundleContextHistoryOutputs("switch-session", ["opaque-a", "opaque-b"], 0));
    expect(captured.at(-1)?.account).toBe("fixture-account-b");
    expect(captured.at(-1)?.body).toContain("opaque-a");
    expect(captured.at(-1)?.body).toContain("opaque-b");
    expect(captured.at(-1)?.body).not.toContain("ocx-context-history-v1:");
    expect(readContextHistoryAccounts("switch-session")).toHaveLength(2);
    expect(readContextAccountBinding("switch-session")?.accountId).toBe("pool-a");
  } finally { globalThis.fetch = originalFetch; }
});

test("storage access ignores inference quota but still rejects reauthentication and removed accounts", async () => {
  const id = "storage-quota-fixture";
  const accessToken = fakeChatGptJwt({ chatgpt_account_id: "fixture-account-a" });
  config.codexAccounts = [{ id, email: "fixture@example.test", isMain: false }];
  saveCodexAccountCredential(id, { accessToken, refreshToken: "fixture", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "fixture-account-a" });
  const { resolveCodexAuthContext } = await import("../src/codex/auth-context");
  const owner = await resolveCodexAuthContext(headers(), config, "pool", { accountId: id, contextStorageOnly: true });
  bindContextAccount("fixture-session", "gpt-5.6-sol", owner, headers());
  recordCodexUpstreamOutcome(config, id, 429, { retryAfter: "600" });
  let calls = 0;
  const deps = { fetch: (async () => { calls++; return Response.json({ encrypted_output: "opaque-fixture" }); }) as typeof fetch };
  try {
    expect((await handleContextManagement(request(), config, undefined, deps)).status).toBe(200);
    expect(calls).toBe(1);
    markAccountNeedsReauth(id);
    expect((await handleContextManagement(request(), config, undefined, deps)).status).toBe(409);
    clearAccountNeedsReauth(id);
    config.codexAccounts = [];
    expect((await handleContextManagement(request(), config, undefined, deps)).status).toBe(409);
    expect(calls).toBe(1);
  } finally {
    clearAccountNeedsReauth(id);
    clearCodexAccountCooldown(id);
  }
});

test("an inaccessible history segment is explicitly partial and never changes note ownership", async () => {
  bind();
  bind("fixture-account-b");
  const response = await handleContextManagement(request(), config, undefined, {
    fetch: (async () => Response.json({ encrypted_output: "opaque-a" })) as typeof fetch,
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  const body = { input: [{ type: "function_call_output", output: [{ type: "encrypted_content", encrypted_content: result.encrypted_output }] }] };
  expandContextHistoryOutputs(body, "fixture-session");
  expect(JSON.stringify(body)).toContain("1 segments are unavailable; this result is partial");
  expect(readContextAccountBinding("fixture-session")?.identityHash).toBe(readContextHistoryAccounts("fixture-session")[0]?.identityHash);
});


test("alternate account namespaces backend ingestion and storage without changing public window identity", async () => {
  bind();
  const owner = bindContextAccount("fixture-session", "gpt-5.6-sol", { kind: "main", accountId: null }, authHeaders("fixture-account-b"));
  expect(owner.backendSessionId).toBeTruthy();
  expect(owner.backendSessionId).not.toBe("fixture-session");
  const metadata = { session_id: "fixture-session", thread_id: "fixture-thread", window_id: "fixture-thread:1", context_window_id: "public-window", turn_id: "fixture-turn", history_ingest_requested: true };
  const source = authHeaders("fixture-account-b");
  source.set("x-codex-turn-metadata", JSON.stringify(metadata));
  source.set("session-id", "fixture-session");
  source.set("thread-id", "fixture-thread");
  const target = new Headers(source);
  const body = { client_metadata: { session_id: "fixture-session", thread_id: "fixture-thread", "x-codex-turn-metadata": JSON.stringify(metadata) }, input: [{ id: "public-item" }] };
  applyContextAccountSession(owner, source, target, body);
  const mapped = JSON.parse(target.get("x-codex-turn-metadata")!);
  expect(mapped.session_id).toBe(owner.backendSessionId);
  expect(mapped.thread_id).not.toBe(metadata.thread_id);
  expect(mapped.turn_id).not.toBe(metadata.turn_id);
  expect(mapped.window_id).toBe(`${mapped.thread_id}:1`);
  expect(mapped.context_window_id).toBe("public-window");
  expect(target.get("session-id")).toBe(mapped.session_id);
  expect(target.get("thread-id")).toBe(mapped.thread_id);
  expect(body.client_metadata.thread_id).toBe(mapped.thread_id);
  expect(JSON.parse(body.client_metadata["x-codex-turn-metadata"])).toEqual(mapped);
  expect(body.input[0]!.id).toBe("public-item");
  expect(source.get("session-id")).toBe("fixture-session");
  const storageSessions: string[] = [];
  const response = await handleContextManagement(request(undefined, undefined, authHeaders("fixture-account-b")), config, undefined, {
    resolveAuth: async () => ({ kind: "main", accountId: null }),
    materializeAuth: async (_h, _a) => authHeaders("fixture-account-b"),
    fetch: (async (_url, init) => { storageSessions.push(JSON.parse(String(init?.body)).context.session_id); return Response.json({ encrypted_output: "opaque" }); }) as typeof fetch,
  });
  expect(response.status).toBe(200);
  expect(storageSessions).toEqual([owner.backendSessionId!]);
});
