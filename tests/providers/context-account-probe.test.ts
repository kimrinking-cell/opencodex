import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyContextAccountSplitFlag,
  configuredPlanForContextOwner,
  contextAccountCanOwnNotes,
  contextServingIdentitySplit,
  ensureContextNotesOwner,
  isNativeExperimentalContextRequest,
} from "../../src/codex/context-account-probe";
import {
  bindContextAccount,
  contextAccountIdentity,
  readContextAccountBinding,
} from "../../src/codex/context-management";
import { recordCodexUpstreamOutcome } from "../../src/codex/routing";
import type { CodexAuthContext } from "../../src/codex/auth-context";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { handleResponses } from "../../src/server/responses";
import { handleContextManagement } from "../../src/server/context-management";
import type { PreparedResponsesTransportContext } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let previousCodexHome: string | undefined;
let previousOpenCodexHome: string | undefined;

const NATIVE_MODEL = "gpt-6-astra";
// Fernet-shaped ciphertext survives spawn-message plaintext rewriting so recovery
// can still replace function-output parts with the omission marker.
const OPAQUE_BLOB = `g${"A".repeat(127)}`;
const canonicalProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  authMode: "forward",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  codexAccountMode: "direct",
};

function accountHeaders(accountId: string, plan?: string): Headers {
  return new Headers({
    authorization: `Bearer ${fakeChatGptJwt({
      chatgpt_account_id: accountId,
      ...(plan ? { chatgpt_plan_type: plan } : {}),
    })}`,
    "content-type": "application/json",
  });
}

function nativeHeaders(sessionId: string, accountId: string, plan?: string): Headers {
  const headers = accountHeaders(accountId, plan);
  headers.set("x-codex-turn-metadata", JSON.stringify({
    session_id: sessionId,
    history_ingest_requested: true,
  }));
  return headers;
}

function testConfig(): OcxConfig {
  return {
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    gptContextManagement: true,
    providers: { openai: { ...canonicalProvider } },
    codexAccounts: [
      { id: "account-a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-a", plan: "plus" },
      { id: "account-b", email: "b@example.test", isMain: false, chatgptAccountId: "acct-b", plan: "team" },
    ],
    codexAccountNamespaces: { "probe-a": "account-a", "probe-b": "account-b" },
    activeCodexAccountId: "account-a",
    autoSwitchThreshold: 0,
  } as OcxConfig;
}

function poolAuth(accountId: string, chatgptAccountId: string): CodexAuthContext {
  return {
    kind: "pool",
    accountId,
    writerGeneration: 1,
    generation: 1,
    accessToken: `access-${accountId}`,
    chatgptAccountId,
  };
}

function responseRequest(model: string, sessionId: string, accountId: string, input: unknown, plan?: string): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: nativeHeaders(sessionId, accountId, plan),
    body: JSON.stringify({ model, input, stream: false, store: false }),
  });
}

function completedResponse(id: string): Response {
  return Response.json({ id, status: "completed", model: NATIVE_MODEL, output: [] });
}

function encryptedRejection(): Response {
  return Response.json({
    error: {
      message: "The encrypted content could not be verified.",
      type: "invalid_request_error",
      code: "invalid_encrypted_content",
    },
  }, { status: 400 });
}

function opaqueReplayInput(): unknown[] {
  return [
    { type: "function_call", call_id: "call-1", name: "fixture_tool", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "call-1",
      output: [
        { type: "encrypted_content", encrypted_content: OPAQUE_BLOB },
        { type: "input_text", text: "visible tool output" },
      ],
    },
    { type: "reasoning", summary: [], encrypted_content: OPAQUE_BLOB, status: "completed" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-context-account-split-"));
  const codexHome = join(root, "codex");
  const opencodexHome = join(root, "opencodex");
  mkdirSync(codexHome);
  mkdirSync(opencodexHome);
  writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  try { removeTreeWithRetry(root); } catch { rmSync(root, { recursive: true, force: true }); }
});

describe("native context account split gate", () => {
  test("accepts native Sol, Astra, Luna and Terra context turns and rejects wrappers or other providers", () => {
    const headers = nativeHeaders("split-session", "acct-a", "plus");
    const args = {
      headers,
      modelId: NATIVE_MODEL,
      providerName: "openai",
      provider: canonicalProvider,
    };
    expect(isNativeExperimentalContextRequest(args)).toBe(true);
    expect(isNativeExperimentalContextRequest({ ...args, modelId: "gpt-5.6-sol" })).toBe(true);
    expect(isNativeExperimentalContextRequest({ ...args, modelId: "gpt-5.6-luna" })).toBe(true);
    expect(isNativeExperimentalContextRequest({ ...args, modelId: "gpt-5.6-terra" })).toBe(true);
    expect(isNativeExperimentalContextRequest({ ...args, modelId: "probe-a/gpt-6-astra" })).toBe(false);
    expect(isNativeExperimentalContextRequest({ ...args, providerName: "openai-apikey" })).toBe(false);
    expect(isNativeExperimentalContextRequest({ ...args, headers: accountHeaders("acct-a", "plus") })).toBe(false);
  });

  test("split compares Notes identityHash to serving headers, not pool accountId", () => {
    const sessionId = "split-identity-session";
    bindContextAccount(sessionId, NATIVE_MODEL, poolAuth("account-a", "acct-a"), accountHeaders("acct-a", "plus"));
    expect(contextServingIdentitySplit(sessionId, accountHeaders("acct-a", "plus"))).toBe(false);
    expect(contextServingIdentitySplit(sessionId, accountHeaders("acct-b", "team"))).toBe(true);
    expect(contextServingIdentitySplit("no-such-session", accountHeaders("acct-a", "plus"))).toBe(false);
    expect(contextServingIdentitySplit(sessionId, new Headers())).toBe(true);

    const callerSession = "split-caller-session";
    const callerHeaders = accountHeaders("acct-a", "plus");
    bindContextAccount(
      callerSession,
      NATIVE_MODEL,
      { kind: "main", accountId: null },
      callerHeaders,
    );
    expect(readContextAccountBinding(callerSession)?.accountId).toBeNull();
    expect(contextAccountIdentity(callerHeaders)).toBe(
      contextAccountIdentity(accountHeaders("acct-a", "pro")),
    );
    expect(contextServingIdentitySplit(callerSession, accountHeaders("acct-a", "pro"))).toBe(false);
    expect(contextServingIdentitySplit(callerSession, accountHeaders("acct-b", "plus"))).toBe(true);

    const parsed = { _contextNotesSessionId: sessionId, _contextAccountSplit: false as boolean | undefined };
    applyContextAccountSplitFlag(parsed, accountHeaders("acct-b", "team"));
    expect(parsed._contextAccountSplit).toBe(true);
    applyContextAccountSplitFlag(parsed, accountHeaders("acct-a", "plus"));
    expect(parsed._contextAccountSplit).toBe(false);
  });

  test("only Plus and Pro plans may own Notes; Team uses configured plan as a fallback", () => {
    expect(contextAccountCanOwnNotes(accountHeaders("acct-a", "plus"))).toBe(true);
    expect(contextAccountCanOwnNotes(accountHeaders("acct-a", "pro"))).toBe(true);
    expect(contextAccountCanOwnNotes(accountHeaders("acct-a", "pro_lite"))).toBe(true);
    expect(contextAccountCanOwnNotes(accountHeaders("acct-b", "team"))).toBe(false);
    expect(contextAccountCanOwnNotes(accountHeaders("acct-b"))).toBe(false);
    expect(contextAccountCanOwnNotes(accountHeaders("acct-b"), "plus")).toBe(true);
    expect(configuredPlanForContextOwner(testConfig(), poolAuth("account-b", "acct-b"))).toBe("team");
  });

  test("first Plus writer owns Notes while a later Team identity can read that owner", () => {
    const sessionId = "split-owner-session";
    const first = ensureContextNotesOwner(
      sessionId,
      NATIVE_MODEL,
      poolAuth("account-a", "acct-a"),
      accountHeaders("acct-a", "plus"),
    );
    const skippedTeam = ensureContextNotesOwner(
      sessionId,
      NATIVE_MODEL,
      poolAuth("account-b", "acct-b"),
      accountHeaders("acct-b", "team"),
    );
    expect(first?.accountId).toBe("account-a");
    expect(skippedTeam?.accountId).toBe("account-a");
    expect(readContextAccountBinding(sessionId)).toMatchObject({ accountId: "account-a", model: NATIVE_MODEL });

    const solTurn = ensureContextNotesOwner(
      sessionId,
      "gpt-5.6-sol",
      poolAuth("account-b", "acct-b"),
      accountHeaders("acct-b", "team"),
    );
    expect(solTurn).toMatchObject({ accountId: "account-a", model: NATIVE_MODEL });
    expect(readContextAccountBinding(sessionId)).toMatchObject({ accountId: "account-a", model: NATIVE_MODEL });

    const teamFirst = "team-first-session";
    expect(ensureContextNotesOwner(
      teamFirst,
      NATIVE_MODEL,
      poolAuth("account-b", "acct-b"),
      accountHeaders("acct-b", "team"),
    )).toBeUndefined();
    expect(readContextAccountBinding(teamFirst)).toBeUndefined();
    expect(ensureContextNotesOwner(
      teamFirst,
      NATIVE_MODEL,
      poolAuth("account-a", "acct-a"),
      accountHeaders("acct-a", "plus"),
    )?.accountId).toBe("account-a");

    const strictSession = "strict-owner-session";
    bindContextAccount(strictSession, NATIVE_MODEL, poolAuth("account-a", "acct-a"), accountHeaders("acct-a"));
    expect(() => bindContextAccount(
      strictSession,
      NATIVE_MODEL,
      poolAuth("account-b", "acct-b"),
      accountHeaders("acct-b"),
    )).toThrow();
  });
});

describe("native context account split routing", () => {
  function saveSplitCredentials(): void {
    saveCodexAccountCredential("account-a", {
      accessToken: fakeChatGptJwt({ chatgpt_account_id: "acct-a", chatgpt_plan_type: "plus" }),
      refreshToken: "refresh-a",
      expiresAt: Date.now() + 300_000,
      chatgptAccountId: "acct-a",
    });
    saveCodexAccountCredential("account-b", {
      accessToken: fakeChatGptJwt({ chatgpt_account_id: "acct-b", chatgpt_plan_type: "team" }),
      refreshToken: "refresh-b",
      expiresAt: Date.now() + 300_000,
      chatgptAccountId: "acct-b",
    });
  }

  test("A establishes the durable Notes owner while B authenticates its selected account", async () => {
    saveSplitCredentials();
    const config = testConfig();
    const served: Array<{ routeAccount: string | undefined; authAccount: string | null; body: string }> = [];
    const transport = async (context: PreparedResponsesTransportContext) => {
      served.push({
        routeAccount: context.route.codexAccountId,
        authAccount: context.authCtx.kind === "main" ? null : context.authCtx.accountId,
        body: context.request.body,
      });
      return { response: completedResponse(`resp-${served.length}`) };
    };

    const first = await handleResponses(
      responseRequest("probe-a/gpt-6-astra", "split-route-session", "acct-a", "first", "plus"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    );
    expect(first.status).toBe(200);
    await first.text();

    const second = await handleResponses(
      responseRequest("probe-b/gpt-6-astra", "split-route-session", "acct-b", "second", "team"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    );
    expect(second.status).toBe(200);
    await second.text();

    expect(served.map(item => [item.routeAccount, item.authAccount])).toEqual([
      ["account-a", "account-a"],
      ["account-b", "account-b"],
    ]);
    expect(readContextAccountBinding("split-route-session")).toMatchObject({ accountId: "account-a" });
  });

  test("opaque reasoning and function output survive A-to-B, and rejection is not replayed", async () => {
    saveSplitCredentials();
    const config = testConfig();
    const sessionId = "split-opaque-session";
    let bCalls = 0;
    let bBody = "";
    const transport = async (context: PreparedResponsesTransportContext) => {
      if (context.authCtx.kind !== "main" && context.authCtx.accountId === "account-b") {
        bCalls += 1;
        bBody = context.request.body;
        return { response: encryptedRejection() };
      }
      return { response: completedResponse("resp-owner") };
    };

    const owner = await handleResponses(
      responseRequest("probe-a/gpt-6-astra", sessionId, "acct-a", "owner", "plus"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    );
    expect(owner.status).toBe(200);
    await owner.text();

    const rejected = await handleResponses(
      responseRequest("probe-b/gpt-6-astra", sessionId, "acct-b", opaqueReplayInput(), "team"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    );
    expect(rejected.status).toBe(400);
    await rejected.text();
    expect(bCalls).toBe(1);
    expect(bBody).toContain(OPAQUE_BLOB);
    expect(bBody.includes("[encrypted content omitted]")).toBe(false);
    expect(readContextAccountBinding(sessionId)).toMatchObject({ accountId: "account-a" });
  });

  test("same Notes identity still recovers opaque blobs", async () => {
    saveSplitCredentials();
    const config = testConfig();
    const sessionId = "split-same-identity-opaque-session";
    const transport = async () => ({ response: completedResponse("resp-owner") });
    expect((await handleResponses(
      responseRequest("probe-a/gpt-6-astra", sessionId, "acct-a", "owner", "plus"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    )).status).toBe(200);

    const originalFetch = globalThis.fetch;
    const outbound: string[] = [];
    const logCtx = { model: "", provider: "" } as RequestLogContext;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/models")) {
        return Response.json({
          models: ["gpt-6-astra", "gpt-5.6-sol"].map(slug => ({ slug, supported_in_api: true, visibility: "list" })),
        });
      }
      const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
      outbound.push(body);
      if (body.includes(OPAQUE_BLOB)) return encryptedRejection();
      return completedResponse("resp-recovered");
    }) as typeof fetch;
    try {
      const recovered = await handleResponses(
        responseRequest("probe-a/gpt-6-astra", sessionId, "acct-a", opaqueReplayInput(), "plus"),
        config,
        logCtx,
      );
      expect(recovered.status).toBe(200);
      await recovered.text();
      expect(outbound.some(body => body.includes(OPAQUE_BLOB))).toBe(true);
      expect(outbound.some(body => body.includes("[encrypted content omitted]"))).toBe(true);
      expect(logCtx.activeAttempt?.recoveryKinds).toContain("opaque-blob-rejection");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Luna A-to-B opaque rejection is not replayed", async () => {
    saveSplitCredentials();
    const config = testConfig();
    const sessionId = "split-luna-opaque-session";
    let bCalls = 0;
    let bBody = "";
    const transport = async (context: PreparedResponsesTransportContext) => {
      if (context.authCtx.kind !== "main" && context.authCtx.accountId === "account-b") {
        bCalls += 1;
        bBody = context.request.body;
        return { response: encryptedRejection() };
      }
      return { response: completedResponse("resp-owner") };
    };
    expect((await handleResponses(
      responseRequest("probe-a/gpt-6-astra", sessionId, "acct-a", "owner", "plus"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    )).status).toBe(200);
    const rejected = await handleResponses(
      responseRequest("probe-b/gpt-5.6-luna", sessionId, "acct-b", opaqueReplayInput(), "team"),
      config,
      { model: "gpt-5.6-luna", provider: "openai" } as RequestLogContext,
      { preparedRequestTransport: transport },
    );
    expect(rejected.status).toBe(400);
    await rejected.text();
    expect(bCalls).toBe(1);
    expect(bBody).toContain(OPAQUE_BLOB);
    expect(bBody.includes("[encrypted content omitted]")).toBe(false);
    expect(readContextAccountBinding(sessionId)).toMatchObject({ accountId: "account-a" });
  });

  test("Notes relay keeps the Plus owner after Team inference", async () => {
    saveSplitCredentials();
    const config = testConfig();
    const transport = async () => ({ response: completedResponse("resp-ok") });
    const sessionId = "split-notes-session";
    expect((await handleResponses(
      responseRequest("probe-a/gpt-6-astra", sessionId, "acct-a", "owner", "plus"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    )).status).toBe(200);
    expect((await handleResponses(
      responseRequest("probe-b/gpt-6-astra", sessionId, "acct-b", "follow", "team"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    )).status).toBe(200);

    const owner = poolAuth("account-a", "acct-a");
    let resolvedAccount: string | undefined;
    let fetches = 0;
    const notes = await handleContextManagement(new Request("http://127.0.0.1/v1/alpha/notes/v2/read_file", {
      method: "POST",
      headers: nativeHeaders(sessionId, "acct-b", "team"),
      body: JSON.stringify({ context: { session_id: sessionId, current_agent_name: "/root" }, path: "checkpoint" }),
    }), config, undefined, {
      resolveAuth: async (_headers, _config, mode, options) => {
        expect(mode).toBe("pool");
        resolvedAccount = options?.accountId;
        return owner;
      },
      materializeAuth: async () => accountHeaders("acct-a", "plus"),
      fetch: (async () => {
        fetches += 1;
        return Response.json({ encrypted_output: "owner-note" });
      }) as typeof fetch,
    });
    expect(notes.status).toBe(200);
    expect(resolvedAccount).toBe("account-a");
    expect(fetches).toBe(1);
    expect(await notes.json()).toEqual({ encrypted_output: "owner-note" });
  });

  test("Notes write after Luna inference still uses the Plus owner", async () => {
    saveSplitCredentials();
    const config = testConfig();
    const transport = async () => ({ response: completedResponse("resp-ok") });
    const sessionId = "split-luna-notes-session";
    expect((await handleResponses(
      responseRequest("probe-a/gpt-6-astra", sessionId, "acct-a", "owner", "plus"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    )).status).toBe(200);
    expect((await handleResponses(
      responseRequest("gpt-5.6-luna", sessionId, "acct-b", "luna", "team"),
      config,
      { model: "gpt-5.6-luna", provider: "openai" } as RequestLogContext,
      { preparedRequestTransport: transport },
    )).status).toBe(200);
    expect(readContextAccountBinding(sessionId)).toMatchObject({ accountId: "account-a", model: NATIVE_MODEL });

    const owner = poolAuth("account-a", "acct-a");
    let resolvedAccount: string | undefined;
    let writes = 0;
    const notes = await handleContextManagement(new Request("http://127.0.0.1/v1/alpha/notes/v2/write_file", {
      method: "POST",
      headers: nativeHeaders(sessionId, "acct-b", "team"),
      body: JSON.stringify({
        context: { session_id: sessionId, current_agent_name: "/root" },
        path: "continuity/current.md",
        content: "luna-updated",
      }),
    }), config, undefined, {
      resolveAuth: async (_headers, _config, mode, options) => {
        expect(mode).toBe("pool");
        resolvedAccount = options?.accountId;
        return owner;
      },
      materializeAuth: async () => accountHeaders("acct-a", "plus"),
      fetch: (async () => {
        writes += 1;
        return Response.json({ encrypted_output: "owner-write" });
      }) as typeof fetch,
    });
    expect(notes.status).toBe(200);
    expect(resolvedAccount).toBe("account-a");
    expect(writes).toBe(1);
    expect(await notes.json()).toEqual({ encrypted_output: "owner-write" });
  });

  test("History paths do not fetch upstream after owner inference", async () => {
    saveSplitCredentials();
    const config = testConfig();
    const transport = async () => ({ response: completedResponse("resp-ok") });
    const sessionId = "split-history-session";
    expect((await handleResponses(
      responseRequest("probe-a/gpt-6-astra", sessionId, "acct-a", "owner", "plus"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    )).status).toBe(200);

    let fetches = 0;
    const history = await handleContextManagement(new Request("http://127.0.0.1/v1/alpha/history/v2/search_contents", {
      method: "POST",
      headers: nativeHeaders(sessionId, "acct-b", "team"),
      body: JSON.stringify({
        context: { session_id: sessionId, current_agent_name: "/root" },
        query: "does-not-matter",
      }),
    }), config, undefined, {
      fetch: (async () => {
        fetches += 1;
        return Response.json({ encrypted_output: "should-not-run" });
      }) as typeof fetch,
    });
    expect(history.status).toBe(404);
    expect((await history.json() as { error?: { type?: string } }).error?.type).toBe("context_history_disabled");
    expect(fetches).toBe(0);
  });

  test("Notes relay still uses the Plus owner after that account hits inference quota", async () => {
    saveSplitCredentials();
    const config = testConfig();
    const transport = async () => ({ response: completedResponse("resp-ok") });
    const sessionId = "split-quota-notes-session";
    expect((await handleResponses(
      responseRequest("probe-a/gpt-6-astra", sessionId, "acct-a", "owner", "plus"),
      config,
      { model: "", provider: "" } as RequestLogContext,
      { preparedRequestTransport: transport },
    )).status).toBe(200);
    recordCodexUpstreamOutcome(config, "account-a", 429, {
      retryAfter: "60",
      now: Date.now(),
      modelId: NATIVE_MODEL,
    });

    let fetches = 0;
    const notes = await handleContextManagement(new Request("http://127.0.0.1/v1/alpha/notes/v2/read_file", {
      method: "POST",
      headers: nativeHeaders(sessionId, "acct-b", "team"),
      body: JSON.stringify({ context: { session_id: sessionId, current_agent_name: "/root" }, path: "checkpoint" }),
    }), config, undefined, {
      fetch: (async () => {
        fetches += 1;
        return Response.json({ encrypted_output: "owner-note" });
      }) as typeof fetch,
    });
    expect(notes.status).toBe(200);
    expect(fetches).toBe(1);
    expect(await notes.json()).toEqual({ encrypted_output: "owner-note" });
  });
});
