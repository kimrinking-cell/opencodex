/**
 * Same-connection native Responses WebSocket transport for Astra.
 *
 * Route selection, context/account binding, adapter normalization, and request-body accounting
 * stay in handleResponses. This module receives the already prepared request, opens one upstream
 * WebSocket, and exposes its event frames as an SSE Response so the existing downstream relay and
 * request observers remain in the path.
 */

import {
  CODEX_WS_CREATE_FRAME_LIMIT_BYTES,
  MAX_CODEX_WS_FRAME_BYTES,
} from "./ws-upstream";

export const NATIVE_ASTRA_MODEL = "gpt-6-astra";
export const NATIVE_WS_CONNECT_TIMEOUT_MS = 10_000;
export const NATIVE_WS_MAX_FRAME_BYTES = MAX_CODEX_WS_FRAME_BYTES;
export const NATIVE_WS_MAX_CREATE_FRAME_BYTES = CODEX_WS_CREATE_FRAME_LIMIT_BYTES;
export const NATIVE_WS_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

const OPEN = 1;
const CLOSED = 3;
const WS_BETA = "responses_websockets=2026-02-06";
const RESPONSE_TERMINAL_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

export interface NativeResponsesWsClient {
  readyState: number;
  send(payload: string): number | void;
  close(code?: number, reason?: string): void;
}

export interface NativeResponsesWsUpstream {
  readonly readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void;
}

export type NativeResponsesWsFactory = (
  url: string,
  headers: Record<string, string>,
) => NativeResponsesWsUpstream;

export interface NativeResponsesTurnLease {
  bindAbortController?(controller: AbortController): void;
  release(): void;
}

export interface NativeResponsesPreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface NativeResponsesWsStartOptions {
  client: NativeResponsesWsClient;
  request: NativeResponsesPreparedRequest;
  modelId: string;
  turnLease: NativeResponsesTurnLease;
  /** Re-admit a later same-socket continuation after the prior turn settled. */
  acquireTurnLease?: () => NativeResponsesTurnLease | undefined;
  /** The canonical handleResponses abort signal/controller for this prepared request. */
  abortSignal?: AbortSignal;
  abortUpstream?: (reason?: unknown) => void;
  /** Deterministic fixture seam; production uses the platform WebSocket. */
  createWebSocket?: NativeResponsesWsFactory;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  maxCreateFrameBytes?: number;
  maxQueuedBytes?: number;
}

export interface NativeResponsesWsSession {
  handleClientFrame(frame: Record<string, unknown>): boolean;
  close(code?: number, reason?: string): void;
  isClosed(): boolean;
}

export type NativeResponsesWsStartResult =
  | {
      kind: "started";
      session: NativeResponsesWsSession;
      response: Response;
      /** The upstream handshake completed; a later failure must never replay over HTTP. */
      hostObserved: true;
    }
  | { kind: "fallback"; hostObserved: false }
  | { kind: "rejected"; hostObserved: false };

const activeSessions = new WeakMap<object, NativeResponsesWsSession>();
const pendingSessions = new WeakMap<object, NativeResponsesWsSession>();
const startingClients = new WeakSet<object>();

export function nativeResponsesSessionFor(client: object): NativeResponsesWsSession | undefined {
  return activeSessions.get(client);
}

export function nativeResponsesSessionStarting(client: object): boolean {
  return startingClients.has(client);
}

export function markNativeResponsesSessionStarting(client: object): boolean {
  if (activeSessions.has(client) || startingClients.has(client)) return false;
  startingClients.add(client);
  return true;
}

export function clearNativeResponsesSessionStarting(client: object): void {
  startingClients.delete(client);
}

export function closeNativeResponsesSession(client: object, code = 1000, reason = "client closed"): void {
  const session = activeSessions.get(client) ?? pendingSessions.get(client);
  session?.close(code, reason);
  activeSessions.delete(client);
  pendingSessions.delete(client);
  startingClients.delete(client);
}

function websocketUrl(url: string): string {
  return url.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

function websocketHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "content-type" || lower === "content-length" || lower === "accept" || lower === "accept-encoding") continue;
    result[name] = value;
  }
  const existingBeta = result["openai-beta"] ?? result["Openai-Beta"];
  result["openai-beta"] = existingBeta
    ? existingBeta.includes("responses_websockets") ? existingBeta : `${existingBeta}, ${WS_BETA}`
    : WS_BETA;
  return result;
}

function frameBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function stringifyFrame(frame: Record<string, unknown>): string | undefined {
  try {
    const text = JSON.stringify(frame);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function eventType(event: Record<string, unknown>): string | undefined {
  return typeof event.type === "string" ? event.type : undefined;
}

function responseIdFromEvent(event: Record<string, unknown>): string | undefined {
  const response = objectRecord(event.response);
  return typeof response?.id === "string" && response.id.trim() ? response.id : undefined;
}

function incompleteReason(event: Record<string, unknown>): string | undefined {
  const response = objectRecord(event.response);
  const details = objectRecord(response?.incomplete_details);
  return typeof details?.reason === "string" ? details.reason : undefined;
}

function dataText(event: unknown): string {
  const data = (event as { data?: unknown } | undefined)?.data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return "";
}

function normalizeCreateFrame(body: string, modelId: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    const record = objectRecord(parsed);
    if (!record) return undefined;
    const frame = { ...record };
    delete frame.type;
    delete frame.stream;
    delete frame.generate;
    if (typeof frame.model !== "string" || !frame.model.trim()) frame.model = modelId;
    frame.type = "response.create";
    return stringifyFrame(frame);
  } catch {
    return undefined;
  }
}

function normalizeContinuationFrame(frame: Record<string, unknown>, modelId: string): string | undefined {
  const next = { ...frame };
  delete next.stream;
  delete next.generate;
  delete next.type;
  if (typeof next.model !== "string" || !next.model.trim()) next.model = modelId;
  next.type = "response.create";
  return stringifyFrame(next);
}

function validSteerInput(input: unknown): boolean {
  if (typeof input === "string") return input.trim().length > 0;
  return Array.isArray(input) && input.length > 0;
}

function validateSteerFrame(frame: Record<string, unknown>, currentResponseId: string | undefined): string | undefined {
  if (typeof frame.previous_response_id !== "string" || !frame.previous_response_id.trim()) {
    return "response.steer requires previous_response_id";
  }
  if (currentResponseId !== undefined && frame.previous_response_id !== currentResponseId) {
    return "response.steer previous_response_id does not match the active response";
  }
  if (!validSteerInput(frame.input)) return "response.steer input must be a non-empty string or array";
  if (Object.keys(frame).some(key => key !== "type" && key !== "previous_response_id" && key !== "input")) {
    return "response.steer accepts only previous_response_id and input";
  }
  return undefined;
}

function errorPayload(code: string, message: string): Record<string, unknown> {
  return {
    type: "error",
    error: { type: "invalid_request_error", code, message },
  };
}

function failedPayload(code: string, message: string): Record<string, unknown> {
  return {
    type: "response.failed",
    response: {
      status: "failed",
      error: { type: "upstream_error", code, message },
      last_error: { type: "upstream_error", code, message },
    },
  };
}

class NativeResponsesWsSessionImpl implements NativeResponsesWsSession {
  private upstream: NativeResponsesWsUpstream | undefined;
  private response: Response | undefined;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private opened = false;
  private sentCreate = false;
  private closed = false;
  private activeResponse = false;
  private awaitingSuccessor = false;
  private currentResponseId: string | undefined;
  private readonly responseIds = new Set<string>();
  private turnLease: NativeResponsesTurnLease | undefined;
  private readonly continuationControllers = new Set<AbortController>();
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private startResolve: ((result: NativeResponsesWsStartResult) => void) | undefined;
  private startSettled = false;
  private bodyClosed = false;

  constructor(private readonly options: NativeResponsesWsStartOptions) {
    this.turnLease = options.turnLease;
  }

  start(): Promise<NativeResponsesWsStartResult> {
    const resultPromise = new Promise<NativeResponsesWsStartResult>(resolve => {
      this.startResolve = resolve;
    });
    const clientKey = this.options.client as object;
    if (activeSessions.has(clientKey) || pendingSessions.has(clientKey)) {
      this.startSettled = true;
      this.startResolve?.({ kind: "rejected", hostObserved: false });
      this.startResolve = undefined;
      return resultPromise;
    }
    pendingSessions.set(clientKey, this);
    const factory = this.options.createWebSocket ?? ((url, headers) => (
      new WebSocket(url, { headers } as unknown as string[])
    ));
    let upstream: NativeResponsesWsUpstream;
    try {
      upstream = factory(websocketUrl(this.options.request.url), websocketHeaders(this.options.request.headers));
    } catch {
      pendingSessions.delete(clientKey);
      this.resolveFallback();
      return resultPromise;
    }
    this.upstream = upstream;
    upstream.addEventListener("open", () => this.onOpen());
    upstream.addEventListener("message", event => this.onMessage(event));
    upstream.addEventListener("close", event => this.onClose(event));
    upstream.addEventListener("error", () => this.onError());
    if (upstream.readyState === OPEN) queueMicrotask(() => this.onOpen());
    const timeoutMs = this.options.connectTimeoutMs ?? NATIVE_WS_CONNECT_TIMEOUT_MS;
    this.connectTimer = setTimeout(() => {
      if (this.opened || this.closed) return;
      this.closeUpstream();
      this.resolveFallback();
    }, timeoutMs);
    if (this.options.abortSignal?.aborted) {
      this.closeUpstream();
      this.resolveFallback();
    } else {
      this.options.abortSignal?.addEventListener("abort", () => {
        if (!this.opened) this.resolveFallback();
        else this.close(1000, "request cancelled");
      }, { once: true });
    }
    return resultPromise;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private resolveFallback(): void {
    if (this.startSettled || this.opened || this.sentCreate) return;
    this.startSettled = true;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    const clientKey = this.options.client as object;
    pendingSessions.delete(clientKey);
    this.startResolve?.({ kind: "fallback", hostObserved: false });
    this.startResolve = undefined;
  }

  private resolveStarted(): void {
    if (this.startSettled || !this.response) return;
    this.startSettled = true;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    const clientKey = this.options.client as object;
    pendingSessions.delete(clientKey);
    if (!this.closed) activeSessions.set(clientKey, this);
    this.startResolve?.({ kind: "started", session: this, response: this.response, hostObserved: true });
    this.startResolve = undefined;
  }

  private closeUpstream(code = 1000, reason = ""): void {
    const upstream = this.upstream;
    if (!upstream || upstream.readyState === CLOSED) return;
    try { upstream.close(code, reason); } catch { /* already closed */ }
  }

  private closeBody(): void {
    if (this.bodyClosed) return;
    this.bodyClosed = true;
    try { this.controller?.close(); } catch { /* already closed */ }
    const clientKey = this.options.client as object;
    activeSessions.delete(clientKey);
    pendingSessions.delete(clientKey);
    this.releaseTurnLease();
  }

  private releaseTurnLease(): void {
    const lease = this.turnLease;
    this.turnLease = undefined;
    try { lease?.release(); } catch { /* admission release is idempotent */ }
  }

  private acquireTurnLease(): boolean {
    if (this.turnLease) return true;
    const lease = this.options.acquireTurnLease?.();
    if (!lease) return false;
    this.turnLease = lease;
    const controller = new AbortController();
    lease.bindAbortController?.(controller);
    this.continuationControllers.add(controller);
    return true;
  }

  private enqueueEvent(text: string, failOnLimit = true): boolean {
    if (this.bodyClosed || !this.controller) return false;
    const maxFrameBytes = this.options.maxFrameBytes ?? NATIVE_WS_MAX_FRAME_BYTES;
    if (frameBytes(text) > maxFrameBytes) {
      if (failOnLimit) this.failOpened("upstream_frame_too_large", "Native Responses WebSocket frame exceeded the size limit");
      return false;
    }
    const encoded = new TextEncoder().encode(`data: ${text}\n\n`);
    const maxQueuedBytes = this.options.maxQueuedBytes ?? NATIVE_WS_MAX_QUEUED_BYTES;
    if (encoded.byteLength > maxQueuedBytes || (this.controller.desiredSize ?? 0) < encoded.byteLength) {
      if (failOnLimit) this.failOpened("upstream_queue_limit", "Native Responses WebSocket response queue exceeded the size limit");
      return false;
    }
    try {
      this.controller.enqueue(encoded);
      return true;
    } catch {
      if (failOnLimit) this.failOpened("response_stream_closed", "Native Responses WebSocket response stream closed");
      return false;
    }
  }

  private failOpened(code: string, message: string): void {
    if (this.closed) return;
    this.enqueueEvent(JSON.stringify(failedPayload(code, message)), false);
    this.closed = true;
    this.options.abortUpstream?.(new Error(message));
    this.closeUpstream(1011, message);
    this.closeBody();
  }

  private onOpen(): void {
    if (this.closed || this.opened) return;
    this.opened = true;
    this.response = new Response(
      new ReadableStream<Uint8Array>({
        start: controller => { this.controller = controller; },
        cancel: reason => this.close(1000, typeof reason === "string" ? reason : "response body cancelled"),
      }, new ByteLengthQueuingStrategy({ highWaterMark: this.options.maxQueuedBytes ?? NATIVE_WS_MAX_QUEUED_BYTES })),
      { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } },
    );
    const frameText = normalizeCreateFrame(this.options.request.body, this.options.modelId);
    if (!frameText || frameBytes(frameText) > (this.options.maxCreateFrameBytes ?? NATIVE_WS_MAX_CREATE_FRAME_BYTES)) {
      this.failOpened("message_too_large", "Native Responses WebSocket response.create frame is too large");
      this.resolveStarted();
      return;
    }
    try {
      // The socket is open before this send. A throw is therefore ambiguous and must not fall back
      // to HTTP/SSE, even though no response event has arrived yet.
      this.upstream?.send(frameText);
      this.sentCreate = true;
      this.activeResponse = true;
    } catch {
      this.failOpened("create_send_failed", "Native Responses WebSocket response.create send failed");
    }
    this.resolveStarted();
  }

  private onMessage(rawEvent: unknown): void {
    if (this.closed) return;
    const text = dataText(rawEvent);
    if (!text || frameBytes(text) > (this.options.maxFrameBytes ?? NATIVE_WS_MAX_FRAME_BYTES)) {
      this.failOpened("upstream_frame_too_large", "Native Responses WebSocket frame exceeded the size limit");
      return;
    }
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      const record = objectRecord(parsed);
      if (!record || typeof record.type !== "string") throw new Error("invalid event");
      event = record;
    } catch {
      this.failOpened("upstream_protocol_error", "Native Responses WebSocket returned an invalid event");
      return;
    }
    if (!this.enqueueEvent(text)) return;
    const type = eventType(event);
    if (type === "response.created") {
      const id = responseIdFromEvent(event);
      if (id) {
        this.currentResponseId = id;
        this.responseIds.add(id);
      }
      this.activeResponse = true;
      this.awaitingSuccessor = false;
      return;
    }
    if (type === "response.steer.pending") {
      this.activeResponse = false;
      this.awaitingSuccessor = true;
      this.releaseTurnLease();
      return;
    }
    if (!RESPONSE_TERMINAL_TYPES.has(type ?? "")) return;
    const steered = type === "response.incomplete" && incompleteReason(event) === "steered";
    this.activeResponse = false;
    this.awaitingSuccessor = steered;
    if (!steered) this.releaseTurnLease();
  }

  private onError(): void {
    if (!this.opened || this.closed) return;
    // Bun dispatches close after error; the close handler emits the bounded failure if needed.
  }

  private onClose(_event: unknown): void {
    if (this.closed) return;
    if (!this.opened && !this.sentCreate) {
      this.resolveFallback();
      return;
    }
    if (this.activeResponse || this.awaitingSuccessor || !this.currentResponseId) {
      this.enqueueEvent(JSON.stringify(failedPayload(
        "upstream_disconnect",
        "Native Responses WebSocket closed before the response completed",
      )));
    }
    this.closed = true;
    this.closeBody();
  }

  close(code = 1000, reason = "client closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.options.abortUpstream?.(reason);
    for (const controller of this.continuationControllers) controller.abort(reason);
    this.continuationControllers.clear();
    this.closeUpstream(code, reason);
    this.closeBody();
    if (!this.startSettled && !this.opened) this.resolveFallback();
  }

  handleClientFrame(frame: Record<string, unknown>): boolean {
    if (this.closed) return true;
    const type = eventType(frame);
    if (type === "response.processed") return true;
    if (type === "response.steer") {
      const validation = validateSteerFrame(frame, this.currentResponseId);
      if (validation) {
        this.enqueueEvent(JSON.stringify({ type: "response.steer.failed", error: { code: "invalid_steering", message: validation } }));
        return true;
      }
      if (!this.acquireTurnLease()) {
        this.enqueueEvent(JSON.stringify({ type: "response.steer.failed", error: { code: "server_busy", message: "active turns capacity reached" } }));
        return true;
      }
      return this.sendClientFrame(frame, "steering_send_failed");
    }
    if (type === "response.create") {
      const model = frame.model;
      if (typeof model === "string" && model.trim() && model !== this.options.modelId) {
        this.enqueueEvent(JSON.stringify(errorPayload("model_change_unsupported", "A native Responses WebSocket session cannot change model")));
        return true;
      }
      if (this.activeResponse) {
        this.enqueueEvent(JSON.stringify(errorPayload("response_active", "response.create cannot replace an active native response")));
        return true;
      }
      const previous = frame.previous_response_id;
      if (previous !== undefined && (typeof previous !== "string" || !this.responseIds.has(previous))) {
        this.enqueueEvent(JSON.stringify(errorPayload("unknown_previous_response", "previous_response_id is not known on this native WebSocket session")));
        return true;
      }
      if (!this.acquireTurnLease()) {
        this.enqueueEvent(JSON.stringify(errorPayload("server_busy", "active turns capacity reached")));
        return true;
      }
      const text = normalizeContinuationFrame(frame, this.options.modelId);
      if (!text || frameBytes(text) > (this.options.maxCreateFrameBytes ?? NATIVE_WS_MAX_CREATE_FRAME_BYTES)) {
        this.enqueueEvent(JSON.stringify(errorPayload("message_too_large", "response.create frame is too large")));
        return true;
      }
      this.activeResponse = true;
      this.awaitingSuccessor = false;
      return this.sendRawUpstream(text, "create_send_failed");
    }
    if (type === "response.cancel") {
      if (!this.activeResponse) {
        this.enqueueEvent(JSON.stringify(errorPayload("response_not_active", "response.cancel has no active response")));
        return true;
      }
      return this.sendClientFrame(frame, "cancel_send_failed");
    }
    return false;
  }

  private sendClientFrame(frame: Record<string, unknown>, failureCode: string): boolean {
    const text = stringifyFrame(frame);
    if (!text || frameBytes(text) > (this.options.maxFrameBytes ?? NATIVE_WS_MAX_FRAME_BYTES)) {
      this.enqueueEvent(JSON.stringify(errorPayload("message_too_large", "WebSocket control frame is too large")));
      return true;
    }
    return this.sendRawUpstream(text, failureCode);
  }

  private sendRawUpstream(text: string, failureCode: string): boolean {
    try {
      if (!this.upstream || this.upstream.readyState !== OPEN) throw new Error("upstream not open");
      this.upstream.send(text);
    } catch {
      // The socket is already open. The send outcome is ambiguous; never retry or replay over SSE.
      this.failOpened(failureCode, "Native Responses WebSocket send failed");
    }
    return true;
  }
}

export async function startNativeResponsesWsSession(
  options: NativeResponsesWsStartOptions,
): Promise<NativeResponsesWsStartResult> {
  const session = new NativeResponsesWsSessionImpl(options);
  return session.start();
}
