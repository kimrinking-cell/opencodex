import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  NATIVE_ASTRA_MODEL,
  NATIVE_WS_MAX_CREATE_FRAME_BYTES,
  startNativeResponsesWsSession,
  type NativeResponsesWsClient,
  type NativeResponsesWsFactory,
  type NativeResponsesWsStartResult,
  type NativeResponsesWsUpstream,
} from "../../src/server/responses/ws-steering";
import { readContextAccountBinding } from "../../src/codex/context-management";
import { saveConfig } from "../../src/config";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";

type EventListener = (event: unknown) => void;
type SendHook = (payload: string, socket: FixtureUpstream) => void;

class FixtureUpstream implements NativeResponsesWsUpstream {
  readyState = 0;
  readonly sent: string[] = [];
  private closed = false;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(private readonly onSend?: SendHook, autoOpen = true, private readonly prettyFrames = false) {
    if (autoOpen) queueMicrotask(() => this.open());
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: string): void {
    if (this.readyState !== 1) throw new Error("fixture upstream is not open");
    this.sent.push(payload);
    this.onSend?.(payload, this);
  }

  close(_code = 1000, _reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.dispatch("close", {});
  }

  open(allowAfterClose = false): void {
    if ((!allowAfterClose && this.closed) || this.readyState === 1) return;
    this.readyState = 1;
    this.dispatch("open", {});
  }

  emitMessage(payload: Record<string, unknown> | string): void {
    if (this.closed) return;
    this.dispatch("message", { data: typeof payload === "string" ? payload : JSON.stringify(payload, null, this.prettyFrames ? 2 : undefined) });
  }

  emitError(): void {
    if (!this.closed) this.dispatch("error", {});
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FixtureClient implements NativeResponsesWsClient {
  readyState = 1;
  readonly sent: string[] = [];
  send(payload: string): number {
    this.sent.push(payload);
    return 1;
  }
  close(): void {
    this.readyState = 3;
  }
}

function lease(onRelease: () => void, onBind?: (controller: AbortController) => void) {
  return {
    bindAbortController(controller: AbortController) { onBind?.(controller); },
    release() { onRelease(); },
  };
}

function responseEvent(id: string, status: "in_progress" | "completed" | "incomplete" = "in_progress") {
  return {
    type: status === "incomplete" ? "response.incomplete" : status === "completed" ? "response.completed" : "response.created",
    response: {
      id,
      object: "response",
      status,
      output: [],
      ...(status === "incomplete" ? { incomplete_details: { reason: "steered" } } : {}),
    },
  };
}

async function nextSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Record<string, unknown> | undefined> {
  const next = await reader.read();
  if (next.done || !next.value) return undefined;
  const text = new TextDecoder().decode(next.value);
  const data = text.split("\n").find(line => line.startsWith("data: "))?.slice(6);
  return data ? JSON.parse(data) as Record<string, unknown> : undefined;
}

async function startedSession(options: {
  client?: NativeResponsesWsClient;
  upstream: FixtureUpstream;
  body?: Record<string, unknown>;
  onCodexWsQuota?: (headers: Headers) => void;
  onInitialSend?: () => void;
  acquireTurnLease?: () => ReturnType<typeof lease> | undefined;
  onTurnRelease?: () => void;
  abortUpstream?: (reason?: unknown) => void;
  connectTimeoutMs?: number;
}): Promise<{ result: Extract<NativeResponsesWsStartResult, { kind: "started" }>; upstream: FixtureUpstream }> {
  const initialIngressFrame = options.body ?? { model: NATIVE_ASTRA_MODEL, input: "fixture", stream: true };
  const result = await startNativeResponsesWsSession({
    client: options.client ?? new FixtureClient(),
    request: {
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: { authorization: "Bearer fixture-token", "chatgpt-account-id": "fixture-account" },
      body: JSON.stringify(initialIngressFrame),
    },
    initialIngressFrame,
    onCodexWsQuota: options.onCodexWsQuota,
    onInitialSend: options.onInitialSend,
    modelId: NATIVE_ASTRA_MODEL,
    turnLease: lease(options.onTurnRelease ?? (() => {})),
    acquireTurnLease: options.acquireTurnLease,
    abortUpstream: options.abortUpstream,
    createWebSocket: (() => options.upstream) as NativeResponsesWsFactory,
    connectTimeoutMs: options.connectTimeoutMs,
  });
  expect(result.kind).toBe("started");
  if (result.kind !== "started") throw new Error(`native fixture did not start: ${result.kind}`);
  return { result, upstream: options.upstream };
}

describe("native Astra Responses WebSocket steering", () => {
  test("preserves a non-generating warmup and permits the later generating request", async () => {
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({
      upstream,
      body: { model: NATIVE_ASTRA_MODEL, input: "fixture", generate: false },
      acquireTurnLease: () => lease(() => {}),
    });
    expect(JSON.parse(upstream.sent[0]!).generate).toBe(false);
    upstream.emitMessage(responseEvent("warmup"));
    upstream.emitMessage(responseEvent("warmup", "completed"));
    result.session.handleClientFrame({ type: "response.create", model: NATIVE_ASTRA_MODEL, input: "continue", previous_response_id: "warmup", generate: true });
    expect(JSON.parse(upstream.sent[1]!).generate).toBe(true);
    result.session.close();
  });

  test("compacts pretty-printed upstream JSON into one SSE data line", async () => {
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({ upstream });
    const reader = result.response.body!.getReader();
    const pretty = JSON.stringify(responseEvent("pretty-1"), null, 2);
    expect(pretty).toContain("\n");
    upstream.emitMessage(pretty);
    const next = await reader.read();
    const text = new TextDecoder().decode(next.value);
    expect(text.startsWith("data: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    const payload = text.slice("data: ".length, -2);
    expect(payload).not.toContain("\n");
    expect(JSON.parse(payload).type).toBe("response.created");
    result.session.close();
  });

  test("drops Responses Lite so native Astra async tools reach the full websocket backend", async () => {
    const upstream = new FixtureUpstream();
    let capturedHeaders: Record<string, string> | undefined;
    const result = await startNativeResponsesWsSession({
      client: new FixtureClient(),
      request: {
        url: "https://chatgpt.com/backend-api/codex/responses",
        headers: {
          authorization: "Bearer fixture-token",
          "x-openai-internal-codex-responses-lite": "true",
        },
        body: JSON.stringify({
          model: NATIVE_ASTRA_MODEL,
          input: "fixture",
          stream: true,
          client_metadata: {
            ws_request_header_x_openai_internal_codex_responses_lite: "true",
            session_id: "keep-me",
          },
        }),
      },
      initialIngressFrame: { model: NATIVE_ASTRA_MODEL, input: "fixture", stream: true },
      modelId: NATIVE_ASTRA_MODEL,
      turnLease: lease(() => {}),
      createWebSocket: ((url, headers) => {
        capturedHeaders = headers;
        return upstream;
      }) as NativeResponsesWsFactory,
    });
    expect(result.kind).toBe("started");
    expect(capturedHeaders?.["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(JSON.parse(upstream.sent[0]!).client_metadata).toEqual({ session_id: "keep-me" });
    if (result.kind === "started") result.session.close();
  });

  test("retires a timed-out fallback so a late upstream open cannot send response.create", async () => {
    let released = 0;
    let initialSends = 0;
    const upstream = new FixtureUpstream(undefined, false);
    const result = await startNativeResponsesWsSession({
      client: new FixtureClient(),
      request: {
        url: "https://chatgpt.com/backend-api/codex/responses",
        headers: { authorization: "Bearer fixture-token" },
        body: JSON.stringify({ model: NATIVE_ASTRA_MODEL, input: "fixture", stream: true }),
      },
      initialIngressFrame: { model: NATIVE_ASTRA_MODEL, input: "fixture", stream: true },
      onInitialSend: () => { initialSends += 1; },
      modelId: NATIVE_ASTRA_MODEL,
      turnLease: lease(() => { released += 1; }),
      connectTimeoutMs: 1,
      createWebSocket: (() => upstream) as NativeResponsesWsFactory,
    });
    expect(result.kind).toBe("fallback");
    expect(released).toBe(0);
    expect(initialSends).toBe(0);

    // The fixture deliberately dispatches a late open after close to model a stale platform event.
    upstream.open(true);
    expect(upstream.sent).toEqual([]);
  });

  test("keeps post-completion accepted/pending steering and the tool-result successor on one socket", async () => {
    let released = 0;
    let acquired = 0;
    let initialSends = 0;
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({
      upstream,
      acquireTurnLease: () => {
        acquired += 1;
        return lease(() => { released += 1; });
      },
      onInitialSend: () => { initialSends += 1; },
    });
    const reader = result.response.body!.getReader();
    expect(JSON.parse(upstream.sent[0]!).type).toBe("response.create");
    expect(initialSends).toBe(1);

    upstream.emitMessage(responseEvent("R1"));
    expect((await nextSseEvent(reader))?.type).toBe("response.created");
    upstream.emitMessage({
      type: "response.output_item.done",
      response_id: "R1",
      output_index: 0,
      item: { type: "function_call", id: "item-c1", call_id: "C1", name: "lookup_marker", arguments: "{}" },
    });
    expect((await nextSseEvent(reader))?.type).toBe("response.output_item.done");
    upstream.emitMessage(responseEvent("R1", "completed"));
    expect((await nextSseEvent(reader))?.type).toBe("response.completed");

    expect(result.session.handleClientFrame({
      type: "response.steer",
      previous_response_id: "R1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
    })).toBe(true);
    upstream.emitMessage({ type: "response.steer.accepted", steer: { id: "S1", previous_response_id: "R1" } });
    expect((await nextSseEvent(reader))?.type).toBe("response.steer.accepted");
    upstream.emitMessage({
      type: "response.steer.pending",
      steer: { id: "S1", previous_response_id: "R1" },
      required_input: [{ type: "function_call_output", call_id: "C1", name: "lookup_marker" }],
    });
    expect((await nextSseEvent(reader))?.type).toBe("response.steer.pending");

    const acquiredBeforeRejectedContinuation = acquired;
    expect(result.session.handleClientFrame({
      type: "response.create",
      previous_response_id: "R1",
      input: [{ type: "function_call_output", call_id: "C1", output: "marker-result" }],
      tools: [{ type: "function", name: "requires-canonical-preparation" }],
    })).toBe(true);
    expect((await nextSseEvent(reader))?.error).toMatchObject({ code: "continuation_preparation_unsupported" });
    expect(acquired).toBe(acquiredBeforeRejectedContinuation);

    expect(result.session.handleClientFrame({
      type: "response.create",
      previous_response_id: "R1",
      input: "x".repeat(NATIVE_WS_MAX_CREATE_FRAME_BYTES),
    })).toBe(true);
    expect((await nextSseEvent(reader))?.error).toMatchObject({ code: "message_too_large" });
    expect(acquired).toBe(acquiredBeforeRejectedContinuation);

    expect(result.session.handleClientFrame({
      type: "response.create",
      previous_response_id: "R1",
      input: [{ type: "function_call_output", call_id: "C1", output: "marker-result" }],
    })).toBe(true);
    expect(upstream.sent.map(frame => JSON.parse(frame).type)).toEqual([
      "response.create", "response.steer", "response.create",
    ]);
    expect(JSON.parse(upstream.sent[2]!).input[0].call_id).toBe("C1");
    expect(acquired).toBe(2);
    expect(initialSends).toBe(1);

    upstream.emitMessage(responseEvent("R2"));
    expect((await nextSseEvent(reader))?.type).toBe("response.created");
    upstream.emitMessage({
      type: "response.output_item.done",
      response_id: "R2",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "STEERING_TOOL_APPLIED" }],
      },
    });
    expect((await nextSseEvent(reader))?.type).toBe("response.output_item.done");
    upstream.emitMessage(responseEvent("R2", "completed"));
    expect((await nextSseEvent(reader))?.type).toBe("response.completed");
    expect(released).toBe(2);

    upstream.close();
    expect(await nextSseEvent(reader)).toBeUndefined();
  });

  test("preserves an outstanding async call across immediate steered incomplete and successor events", async () => {
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({ upstream });
    const reader = result.response.body!.getReader();
    upstream.emitMessage(responseEvent("R-ASYNC"));
    expect((await nextSseEvent(reader))?.type).toBe("response.created");
    upstream.emitMessage({
      type: "response.output_item.done",
      response_id: "R-ASYNC",
      output_index: 0,
      item: { type: "function_call", id: "item-async", call_id: "C-ASYNC", name: "lookup_marker", arguments: "{}", async: true },
    });
    expect((await nextSseEvent(reader))?.type).toBe("response.output_item.done");
    upstream.emitMessage(responseEvent("R-ASYNC", "incomplete"));
    expect((await nextSseEvent(reader))?.type).toBe("response.incomplete");
    expect(result.session.isClosed()).toBe(false);
    expect(upstream.sent).toHaveLength(1);

    upstream.emitMessage(responseEvent("R2-ASYNC"));
    expect((await nextSseEvent(reader))?.type).toBe("response.created");
    upstream.emitMessage(responseEvent("R2-ASYNC", "completed"));
    expect((await nextSseEvent(reader))?.type).toBe("response.completed");
    upstream.close();
    expect(await nextSseEvent(reader)).toBeUndefined();
  });

  test("observes quota and relays sanitized metadata across a retained successor", async () => {
    const observed: string[] = [];
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({
      upstream,
      onCodexWsQuota: headers => {
        const value = headers.get("x-codex-primary-used-percent");
        if (value !== null) observed.push(value);
      },
    });
    const reader = result.response.body!.getReader();

    upstream.emitMessage({
      type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: 12, window_minutes: 300 } },
    });
    expect((await nextSseEvent(reader))?.type).toBe("codex.rate_limits");
    upstream.emitMessage(responseEvent("R1"));
    await nextSseEvent(reader);
    upstream.emitMessage(responseEvent("R1", "completed"));
    await nextSseEvent(reader);

    upstream.emitMessage({
      type: "codex.response.metadata",
      headers: {
        "x-models-etag": "safe-etag",
        authorization: "secret-must-not-relay",
        "set-cookie": "secret-must-not-relay",
        "x-codex-turn-state": "bad\r\nvalue",
      },
    });
    const sanitized = await nextSseEvent(reader);
    expect(sanitized).toEqual({ type: "codex.response.metadata", headers: { "x-models-etag": "safe-etag" } });
    expect(JSON.stringify(sanitized)).not.toContain("secret-must-not-relay");

    upstream.emitMessage(responseEvent("R2"));
    await nextSseEvent(reader);
    upstream.emitMessage({
      type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: 27, window_minutes: 300 } },
    });
    expect((await nextSseEvent(reader))?.type).toBe("codex.rate_limits");
    expect(observed).toEqual(["12", "27"]);
    upstream.emitMessage(responseEvent("R2", "completed"));
    await nextSseEvent(reader);
    upstream.close();
    expect(await nextSseEvent(reader)).toBeUndefined();
  });

  test("keeps a post-terminal steer lease when the matching continuation races pending", async () => {
    let originalReleased = 0;
    let continuationReleased = 0;
    let acquired = 0;
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({
      upstream,
      onTurnRelease: () => { originalReleased += 1; },
      acquireTurnLease: () => {
        acquired += 1;
        return lease(() => { continuationReleased += 1; });
      },
    });
    const reader = result.response.body!.getReader();
    upstream.emitMessage(responseEvent("R1"));
    await nextSseEvent(reader);
    upstream.emitMessage(responseEvent("R1", "completed"));
    await nextSseEvent(reader);

    result.session.handleClientFrame({ type: "response.steer", previous_response_id: "R1", input: "race" });
    upstream.emitMessage({ type: "response.steer.accepted", steer: { id: "S1", previous_response_id: "R1" } });
    await nextSseEvent(reader);
    expect(result.session.handleClientFrame({
      type: "response.create",
      previous_response_id: "R1",
      input: [{ type: "function_call_output", call_id: "C1", output: "result" }],
    })).toBe(true);
    expect(acquired).toBe(1);

    // The server may report pending after the matching create has already arrived. The lease now
    // belongs to the running successor and must survive this status notification.
    upstream.emitMessage({
      type: "response.steer.pending",
      steer: { id: "S1", previous_response_id: "R1" },
      required_input: [{ type: "function_call_output", call_id: "C1" }],
    });
    await nextSseEvent(reader);
    expect(continuationReleased).toBe(0);
    upstream.emitMessage(responseEvent("R2"));
    await nextSseEvent(reader);
    upstream.emitMessage(responseEvent("R2", "completed"));
    await nextSseEvent(reader);
    expect(originalReleased).toBe(1);
    expect(continuationReleased).toBe(1);
    upstream.close();
    expect(await nextSseEvent(reader)).toBeUndefined();
  });

  test("accepts a matching continuation before response.steer.pending", async () => {
    let released = 0;
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({ upstream, onTurnRelease: () => { released += 1; } });
    const reader = result.response.body!.getReader();
    upstream.emitMessage(responseEvent("R1"));
    await nextSseEvent(reader);

    result.session.handleClientFrame({ type: "response.steer", previous_response_id: "R1", input: "continue" });
    upstream.emitMessage({ type: "response.steer.accepted", steer: { id: "S1", previous_response_id: "R1" } });
    await nextSseEvent(reader);
    // The native client can answer a function/custom tool output before pending arrives. The
    // prepared session accepts the matching create while the original response is still active.
    expect(result.session.handleClientFrame({
      type: "response.create",
      previous_response_id: "R1",
      input: [{ type: "custom_tool_call_output", call_id: "C2", output: "custom-result" }],
    })).toBe(true);
    expect(upstream.sent.map(frame => JSON.parse(frame).type)).toEqual([
      "response.create", "response.steer", "response.create",
    ]);
    upstream.emitMessage({
      type: "response.steer.pending",
      steer: { id: "S1", previous_response_id: "R1" },
      required_input: [{ type: "custom_tool_call_output", call_id: "C2" }],
    });
    await nextSseEvent(reader);
    upstream.emitMessage(responseEvent("R1", "completed"));
    await nextSseEvent(reader);
    upstream.emitMessage(responseEvent("R2"));
    await nextSseEvent(reader);
    upstream.emitMessage(responseEvent("R2", "completed"));
    await nextSseEvent(reader);
    expect(released).toBe(1);
    upstream.close();
    expect(await nextSseEvent(reader)).toBeUndefined();
  });

  test("forwards upstream steering failure, rejects invalid input, and never replays after an opened send failure", async () => {
    let releases = 0;
    let originalReleases = 0;
    let acquired = 0;
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({
      upstream,
      onTurnRelease: () => { originalReleases += 1; },
      acquireTurnLease: () => {
        acquired += 1;
        return lease(() => { releases += 1; });
      },
    });
    const reader = result.response.body!.getReader();
    upstream.emitMessage(responseEvent("R1"));
    await nextSseEvent(reader);

    expect(result.session.handleClientFrame({ type: "response.steer", previous_response_id: "R1", input: "active failure" })).toBe(true);
    expect(acquired).toBe(0);
    upstream.emitMessage({ type: "response.steer.failed", steer: { id: "S-active", previous_response_id: "R1" }, error: { code: "not_supported" } });
    expect((await nextSseEvent(reader))?.type).toBe("response.steer.failed");
    expect(originalReleases).toBe(0);

    expect(result.session.handleClientFrame({ type: "response.steer", previous_response_id: "wrong", input: "bad" })).toBe(true);
    expect((await nextSseEvent(reader))?.type).toBe("response.steer.failed");
    expect(acquired).toBe(0);

    upstream.emitMessage(responseEvent("R1", "completed"));
    await nextSseEvent(reader);
    expect(originalReleases).toBe(1);
    expect(result.session.handleClientFrame({ type: "response.steer", previous_response_id: "R1", input: "try again" })).toBe(true);
    expect(acquired).toBe(1);
    upstream.emitMessage({ type: "response.steer.failed", steer: { id: "S2", previous_response_id: "R1" }, error: { code: "not_supported" } });
    expect((await nextSseEvent(reader))?.type).toBe("response.steer.failed");
    expect(releases).toBe(1);

    upstream.emitMessage(responseEvent("R1", "completed"));
    await nextSseEvent(reader);
    upstream.close();
    expect(await nextSseEvent(reader)).toBeUndefined();
  });

  test("accepted steering after response.completed remains unresolved and fails on disconnect", async () => {
    const upstream = new FixtureUpstream();
    const { result } = await startedSession({
      upstream,
      acquireTurnLease: () => lease(() => {}),
    });
    const reader = result.response.body!.getReader();
    upstream.emitMessage(responseEvent("R1"));
    await nextSseEvent(reader);
    upstream.emitMessage(responseEvent("R1", "completed"));
    await nextSseEvent(reader);

    expect(result.session.handleClientFrame({
      type: "response.steer",
      previous_response_id: "R1",
      input: "accepted then disconnected",
    })).toBe(true);
    upstream.emitMessage({ type: "response.steer.accepted", steer: { id: "S1", previous_response_id: "R1" } });
    expect((await nextSseEvent(reader))?.type).toBe("response.steer.accepted");
    upstream.close();

    const failure = await nextSseEvent(reader);
    expect(failure).toMatchObject({ type: "response.failed", response: { error: { code: "upstream_disconnect" } } });
    expect(await nextSseEvent(reader)).toBeUndefined();
  });

  test("does not fall back after an opened ambiguous control-frame send", async () => {
    let abortReason: unknown;
    let steerSend = false;
    const upstream = new FixtureUpstream(payload => {
      if (JSON.parse(payload).type === "response.steer") {
        steerSend = true;
        throw new Error("fixture ambiguous send");
      }
    });
    const { result } = await startedSession({ upstream, abortUpstream: reason => { abortReason = reason; } });
    const reader = result.response.body!.getReader();
    upstream.emitMessage(responseEvent("R1"));
    await nextSseEvent(reader);
    result.session.handleClientFrame({ type: "response.steer", previous_response_id: "R1", input: "ambiguous" });
    expect((await nextSseEvent(reader))?.type).toBe("response.failed");
    expect(steerSend).toBe(true);
    expect(abortReason).toBeInstanceOf(Error);
    expect(result.kind).toBe("started");
    expect(await nextSseEvent(reader)).toBeUndefined();
  });
});

describe("composed native Astra endpoint", () => {
  test("uses canonical context binding with pretty JSON, Lite ingress, steering and async tool IDs on one socket", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const previousFetch = globalThis.fetch;
    const home = mkdtempSync(join(tmpdir(), "ocx-astra-ws-"));
    const codexHome = installIsolatedCodexHome("ocx-astra-ws-codex-");
    const accountToken = fakeChatGptJwt({ chatgpt_account_id: "fixture-account" });
    let upstream: FixtureUpstream | undefined;
    let upstreamUrl = "";
    let upstreamHeaders: Record<string, string> = {};
    let sawInitialCreate = false;
    let sawSteer = false;
    let sawContinuation = false;

    try {
      process.env.OPENCODEX_HOME = home;
      globalThis.fetch = (async () => Response.json({ models: [] })) as typeof fetch;
      const factory: NativeResponsesWsFactory = (url, headers) => {
        upstreamUrl = url;
        upstreamHeaders = { ...headers };
        upstream = new FixtureUpstream((payload, socket) => {
          const frame = JSON.parse(payload) as Record<string, unknown>;
          if (frame.type === "response.create" && !sawInitialCreate) {
            sawInitialCreate = true;
            queueMicrotask(() => {
              socket.emitMessage(responseEvent("R1"));
              socket.emitMessage({
                type: "response.output_item.done",
                response_id: "R1",
                output_index: 0,
                item: { type: "function_call", id: "item-c1", call_id: "C1", name: "lookup_marker", arguments: "{}" },
              });
              socket.emitMessage(responseEvent("R1", "completed"));
            });
          } else if (frame.type === "response.steer" && !sawSteer) {
            sawSteer = true;
            queueMicrotask(() => {
              socket.emitMessage({ type: "response.steer.accepted", steer: { id: "S1", previous_response_id: "R1" } });
              socket.emitMessage({
                type: "response.steer.pending",
                steer: { id: "S1", previous_response_id: "R1" },
                required_input: [{ type: "function_call_output", call_id: "C1", name: "lookup_marker" }],
              });
            });
          } else if (frame.type === "response.create" && frame.previous_response_id === "R1" && !sawContinuation) {
            sawContinuation = true;
            queueMicrotask(() => {
              socket.emitMessage(responseEvent("R2"));
              socket.emitMessage({
                type: "response.output_item.done",
                response_id: "R2",
                output_index: 0,
                item: { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "STEERING_TOOL_APPLIED" }] },
              });
              socket.emitMessage({ type: "response.completed", response: { id: "R2", object: "response", status: "completed", output: [] } });
              queueMicrotask(() => socket.close());
            });
          }
        }, true, true);
        return upstream;
      };

      const config: OcxConfig = {
        port: 0,
        hostname: "127.0.0.1",
        websockets: true,
        codexAutoStart: false,
        openaiProviderTierVersion: 2,
        defaultProvider: "openai",
        gptContextManagement: true,
        providers: {
          openai: {
            adapter: "openai-responses",
            authMode: "forward",
            codexAccountMode: "direct",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        },
      } as OcxConfig;
      saveConfig(config);
      const server = startServer(0, {
        inspectNativeCodexOwnership: ownedServiceHomeInspection("native Astra WS fixture"),
        nativeAstraWebSocketFactory: factory,
      });
      try {
        const nativeConfig: Record<string, unknown> = {
          instructions: "fixture native instructions",
          tools: [{ type: "function", name: "lookup_marker", description: "fixture lookup", parameters: { type: "object", properties: {} }, async: true }],
          tool_choice: "auto",
          parallel_tool_calls: false,
          reasoning: { effort: "low" },
          store: false,
          include: ["reasoning.encrypted_content"],
          service_tier: "default",
          prompt_cache_key: "fixture-cache-key",
          text: { format: { type: "text" } },
          client_metadata: {
            session_id: "fixture-session",
            thread_id: "fixture-thread",
            turn_id: "fixture-turn",
            trace_id: "trace-initial",
            ws_request_header_x_openai_internal_codex_responses_lite: "true",
          },
          access_programs: ["fixture-access-program"],
        };
        const continuationInput = [
          { type: "function_call_output", call_id: "C1", output: "marker-result" },
          { type: "custom_tool_call_output", call_id: "C2", output: "custom-marker-result" },
        ];
        const continuationFrame = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
          type: "response.create",
          model: NATIVE_ASTRA_MODEL,
          previous_response_id: "R1",
          input: continuationInput,
          ...nativeConfig,
          ...overrides,
        });
        const wsUrl = new URL("/v1/responses", server.url);
        wsUrl.protocol = "ws:";
        const client = new WebSocket(wsUrl, {
          headers: {
            authorization: `Bearer ${accountToken}`,
            "x-codex-turn-metadata": JSON.stringify({ session_id: "fixture-session", history_ingest_requested: true }),
            "X-OpenAI-Internal-Codex-Responses-Lite": "true",
          },
        } as unknown as string[]);
        const received: Record<string, unknown>[] = [];
        let sentSteer = false;
        let sentContinuation = false;
        const rejectedContinuations: Record<string, unknown>[] = [];
        const completed = await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("native Astra WS fixture timeout")), 8_000);
          client.addEventListener("open", () => {
            client.send(JSON.stringify({
              type: "response.create",
              model: NATIVE_ASTRA_MODEL,
              input: [{ role: "user", content: "lookup" }],
              ...nativeConfig,
            }));
          }, { once: true });
          client.addEventListener("message", event => {
            try {
              const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
              received.push(frame);
              if (frame.type === "response.completed" && (frame.response as Record<string, unknown> | undefined)?.id === "R1" && !sentSteer) {
                sentSteer = true;
                client.send(JSON.stringify({ type: "response.steer", previous_response_id: "R1", input: "apply steering" }));
              }
              if (frame.type === "response.steer.pending" && !sentContinuation) {
                // Explicit continuations repeat the native client's full request settings. A
                // changed setting is rejected before admission/send; the unchanged frame then
                // reuses the canonical prepared values and refreshes only trace metadata.
                client.send(JSON.stringify(continuationFrame({ instructions: "changed instructions" })));
              }
              if (frame.type === "error" && (frame.error as Record<string, unknown> | undefined)?.code === "continuation_preparation_unsupported") {
                rejectedContinuations.push(frame);
                if (rejectedContinuations.length === 1) {
                  client.send(JSON.stringify(continuationFrame({
                    client_metadata: { ...(nativeConfig.client_metadata as Record<string, unknown>), session_id: "changed-session" },
                  })));
                } else if (rejectedContinuations.length === 2) {
                  sentContinuation = true;
                  client.send(JSON.stringify(continuationFrame({
                    client_metadata: { ...(nativeConfig.client_metadata as Record<string, unknown>), trace_id: "trace-successor" },
                  })));
                }
              }
              if (frame.type === "response.completed" && (frame.response as Record<string, unknown> | undefined)?.id === "R2") {
                clearTimeout(timer);
                resolve();
              }
            } catch (error) {
              clearTimeout(timer);
              reject(error);
            }
          });
          client.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("native Astra WS fixture client error"));
          }, { once: true });
        });
        void completed;
        await new Promise(resolve => setTimeout(resolve, 20));
        client.close();

        expect(received.map(frame => frame.type)).toEqual([
          "response.created",
          "response.output_item.done",
          "response.completed",
          "response.steer.accepted",
          "response.steer.pending",
          "error",
          "error",
          "response.created",
          "response.output_item.done",
          "response.completed",
        ]);
        expect((received[1]!.item as Record<string, unknown>).call_id).toBe("C1");
        const successorOutput = received.find(frame => frame.type === "response.output_item.done" && frame.response_id === "R2");
        expect((successorOutput?.item as Record<string, unknown> | undefined)?.content?.[0]?.text).toBe("STEERING_TOOL_APPLIED");
        expect(upstreamUrl).toBe("wss://chatgpt.com/backend-api/codex/responses");
        expect(upstreamHeaders["openai-beta"]).toContain("responses_websockets=2026-02-06");
        expect(Object.keys(upstreamHeaders).some(key => key.toLowerCase() === "x-openai-internal-codex-responses-lite")).toBe(false);
        expect(upstreamHeaders.authorization).toBe(`Bearer ${accountToken}`);
        expect(upstreamHeaders["chatgpt-account-id"]).toBe("fixture-account");
        expect(upstream?.sent.map(frame => JSON.parse(frame).type)).toEqual([
          "response.create", "response.steer", "response.create",
        ]);
        const initialWire = JSON.parse(upstream?.sent[0] ?? "{}") as Record<string, unknown>;
        const successorWire = JSON.parse(upstream?.sent[2] ?? "{}") as Record<string, unknown>;
        for (const wire of [initialWire, successorWire]) {
          expect((wire.client_metadata as Record<string, unknown>)?.ws_request_header_x_openai_internal_codex_responses_lite).toBeUndefined();
        }
        for (const field of ["instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "include", "service_tier", "prompt_cache_key", "text", "access_programs"]) {
          expect(successorWire[field]).toEqual(initialWire[field]);
        }
        expect((initialWire.tools as Record<string, unknown>[])[0]?.async).toBe(true);
        expect(initialWire).toMatchObject({ parallel_tool_calls: false });
        expect(JSON.stringify(initialWire.input)).toContain("context-failure-report.ts");
        const successorInput = successorWire.input as Record<string, unknown>[];
        expect(successorInput[0]?.call_id).toBe("C1");
        expect(successorInput[1]).toMatchObject({ type: "custom_tool_call_output", call_id: "C2" });
        expect(successorWire.previous_response_id).toBe("R1");
        expect(successorWire.client_metadata).toMatchObject({
          session_id: "fixture-session",
          thread_id: "fixture-thread",
          turn_id: "fixture-turn",
          trace_id: "trace-successor",
        });
        expect(rejectedContinuations).toHaveLength(2);
        expect(readContextAccountBinding("fixture-session")).toMatchObject({ kind: "caller", accountId: null, model: NATIVE_ASTRA_MODEL });
      } finally {
        await server.stop(true);
      }
    } finally {
      globalThis.fetch = previousFetch;
      codexHome.restore();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, { timeout: 20_000 });

  test("returns an explicit steering_unsupported event on the legacy Responses bridge", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const previousFetch = globalThis.fetch;
    const home = mkdtempSync(join(tmpdir(), "ocx-legacy-steer-"));
    const codexHome = installIsolatedCodexHome("ocx-legacy-steer-codex-");
    try {
      process.env.OPENCODEX_HOME = home;
      globalThis.fetch = (async () => Response.json({ models: [] })) as typeof fetch;
      saveConfig({
        port: 0,
        hostname: "127.0.0.1",
        websockets: true,
        codexAutoStart: false,
        openaiProviderTierVersion: 2,
        defaultProvider: "openai",
        providers: {
          openai: {
            adapter: "openai-responses",
            authMode: "forward",
            codexAccountMode: "direct",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        },
      } as OcxConfig);
      const server = startServer(0, { inspectNativeCodexOwnership: ownedServiceHomeInspection("legacy steering fixture") });
      try {
        const wsUrl = new URL("/v1/responses", server.url);
        wsUrl.protocol = "ws:";
        const client = new WebSocket(wsUrl);
        const failure = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("unsupported steering fixture timeout")), 5_000);
          client.addEventListener("open", () => {
            client.send(JSON.stringify({ type: "response.steer", previous_response_id: "R0", input: "unsupported" }));
          }, { once: true });
          client.addEventListener("message", event => {
            clearTimeout(timer);
            resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
          }, { once: true });
          client.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("unsupported steering fixture client error"));
          }, { once: true });
        });
        expect(failure).toMatchObject({ type: "response.steer.failed", error: { code: "steering_unsupported" } });
        client.close();
      } finally {
        await server.stop(true);
      }
    } finally {
      globalThis.fetch = previousFetch;
      codexHome.restore();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, { timeout: 15_000 });
});
