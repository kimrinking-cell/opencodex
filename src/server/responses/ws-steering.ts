/**
 * Same-connection native Responses WebSocket transport for Astra.
 *
 * Route selection, context/account binding, adapter normalization, and request-body accounting
 * stay in handleResponses. This module receives the already prepared request, opens one upstream
 * WebSocket, and exposes its event frames as an SSE Response so the existing downstream relay and
 * request observers remain in the path.
 */

import {
  CODEX_RESPONSES_LITE_HEADER,
  CODEX_RESPONSES_LITE_METADATA_KEY,
} from "../../codex/forward-transport-headers";
import {
  CODEX_WS_CREATE_FRAME_LIMIT_BYTES,
  MAX_CODEX_WS_FRAME_BYTES,
} from "./ws-upstream";
import { CodexWsMetadata, type CodexWsQuotaObserver } from "./codex-ws-metadata";

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
  /** Original first response.create options captured before canonical preparation. */
  initialIngressFrame: Record<string, unknown>;
  /** Canonical account-scoped observer; metadata sanitization remains owned by CodexWsMetadata. */
  onCodexWsQuota?: CodexWsQuotaObserver;
  /** Called exactly once immediately before the actual initial upstream frame send. */
  onInitialSend?: () => void;
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
    if (
      lower === "content-type"
      || lower === "content-length"
      || lower === "accept"
      || lower === "accept-encoding"
      // Native Astra steering carries async tools. Responses Lite rejects those
      // with 400 unsupported_value; the pretty-printed error used to surface as
      // a 502 invalid SSE JSON fatal instead.
      || lower === CODEX_RESPONSES_LITE_HEADER
    ) continue;
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

function withoutLiteMetadata(frame: Record<string, unknown>): Record<string, unknown> {
  const metadata = objectRecord(frame.client_metadata);
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, CODEX_RESPONSES_LITE_METADATA_KEY)) return frame;
  const nextMetadata = { ...metadata };
  delete nextMetadata[CODEX_RESPONSES_LITE_METADATA_KEY];
  const next = { ...frame };
  if (Object.keys(nextMetadata).length === 0) delete next.client_metadata;
  else next.client_metadata = nextMetadata;
  return next;
}

function stringifyFrame(frame: Record<string, unknown>): string | undefined {
  try {
    const text = JSON.stringify(withoutLiteMetadata(frame));
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

function normalizeCreateFrame(body: string, modelId: string, initialIngressFrame: Record<string, unknown>): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    const record = objectRecord(parsed);
    if (!record) return undefined;
    const frame = { ...record };
    delete frame.type;
    delete frame.stream;
    delete frame.generate;
    if (typeof initialIngressFrame.generate === "boolean") frame.generate = initialIngressFrame.generate;
    if (typeof frame.model !== "string" || !frame.model.trim()) frame.model = modelId;
    frame.type = "response.create";
    return stringifyFrame(frame);
  } catch {
    return undefined;
  }
}

const REPEATED_NATIVE_FIELDS = [
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "stream_options",
  "store",
  "include",
  "service_tier",
  "prompt_cache_key",
  "text",
  "client_metadata",
  "access_programs",
] as const;

const CONTINUATION_FRAME_FIELDS = new Set<string>([
  "type",
  "model",
  "previous_response_id",
  "input",
  "stream",
  "generate",
  ...REPEATED_NATIVE_FIELDS,
]);

// These are the only body metadata values allowed to change after canonical preparation. The
// session/thread/turn identity and every other metadata option remain pinned to the first request.
const TRACE_METADATA_FIELDS = new Set([
  "trace_id",
  "span_id",
  "request_id",
  "event_id",
  "attempt_id",
  "request_index",
  "traceparent",
  "tracestate",
]);

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = objectRecord(value);
  if (!record) return JSON.stringify(value);
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function parseBodyRecord(body: string): Record<string, unknown> | undefined {
  try {
    return objectRecord(JSON.parse(body));
  } catch {
    return undefined;
  }
}

function validContinuationInput(input: unknown): boolean {
  if (typeof input === "string") return input.trim().length > 0;
  if (!Array.isArray(input) || input.length === 0) return false;
  // The item itself is new continuation data, but it must be a native Responses item. This keeps
  // function/custom tool outputs and ordinary native message/input items intact without accepting
  // a second request envelope that could smuggle route or account settings.
  return input.every(item => {
    const record = objectRecord(item);
    return typeof record?.type === "string" && record.type.trim().length > 0
      && !hasOwn(record, "model")
      && !hasOwn(record, "instructions")
      && !hasOwn(record, "tools")
      && !hasOwn(record, "tool_choice")
      && !hasOwn(record, "parallel_tool_calls");
  });
}

interface ContinuationFrameResult {
  frame?: Record<string, unknown>;
  error?: string;
  inputError?: boolean;
}

function expectedField(
  field: string,
  initial: Record<string, unknown>,
  canonical: Record<string, unknown>,
): { present: boolean; value: unknown } {
  if (hasOwn(initial, field)) return { present: true, value: initial[field] };
  if (hasOwn(canonical, field)) return { present: true, value: canonical[field] };
  return { present: false, value: undefined };
}

function continuationMetadata(
  initial: Record<string, unknown>,
  canonical: Record<string, unknown>,
  frame: Record<string, unknown>,
): { present: boolean; value: unknown; error?: string } {
  if (!hasOwn(frame, "client_metadata")) {
    return { present: hasOwn(canonical, "client_metadata"), value: canonical.client_metadata };
  }
  const expected = expectedField("client_metadata", initial, canonical);
  const incoming = frame.client_metadata;
  if (!expected.present) {
    const incomingRecord = objectRecord(incoming);
    if (incomingRecord) {
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(incomingRecord)) {
        if (!TRACE_METADATA_FIELDS.has(key)) {
          return { present: false, value: undefined, error: "client_metadata adds an unapproved session option" };
        }
        next[key] = value;
      }
      return { present: true, value: next };
    }
    return { present: false, value: undefined, error: "client_metadata is not compatible with the prepared request" };
  }
  const expectedRecord = objectRecord(expected.value);
  const incomingRecord = objectRecord(incoming);
  if (!expectedRecord || !incomingRecord) {
    return sameJson(expected.value, incoming)
      ? { present: hasOwn(canonical, "client_metadata"), value: canonical.client_metadata }
      : { present: false, value: undefined, error: "client_metadata changed the prepared session" };
  }
  const base = objectRecord(canonical.client_metadata);
  const next = base ? { ...base } : {};
  for (const [key, value] of Object.entries(incomingRecord)) {
    if (TRACE_METADATA_FIELDS.has(key)) {
      next[key] = value;
      continue;
    }
    if (!hasOwn(expectedRecord, key) || !sameJson(expectedRecord[key], value)) {
      return { present: false, value: undefined, error: "client_metadata changed the prepared session" };
    }
  }
  return { present: true, value: next };
}

function prepareContinuationFrame(
  frame: Record<string, unknown>,
  modelId: string,
  initialIngressFrame: Record<string, unknown>,
  canonicalBody: Record<string, unknown> | undefined,
): ContinuationFrameResult {
  if (!canonicalBody) return {
    error: "the canonical prepared request is unavailable for this continuation",
  };
  const unsupported = Object.keys(frame).filter(key => !CONTINUATION_FRAME_FIELDS.has(key));
  if (unsupported.length > 0) return {
    error: "continuation response.create changed route, account, context, or an option requiring canonical preparation",
  };
  if (!hasOwn(frame, "input") || !validContinuationInput(frame.input)) {
    return {
      error: "continuation response.create requires a supported native input item",
      inputError: true,
    };
  }
  const next = { ...canonicalBody };
  delete next.type;
  delete next.stream;
  delete next.generate;
  if (hasOwn(frame, "generate")) {
    if (typeof frame.generate !== "boolean") return { error: "generate must be a boolean" };
    next.generate = frame.generate;
  }
  delete next.previous_response_id;
  const initialModel = initialIngressFrame.model;
  const expectedModel = typeof initialModel === "string" && initialModel.trim() ? initialModel : modelId;
  if (hasOwn(frame, "model") && frame.model !== expectedModel) return {
    error: "continuation response.create cannot change model or route",
  };
  next.model = modelId;
  if (hasOwn(frame, "previous_response_id")) next.previous_response_id = frame.previous_response_id;
  next.input = frame.input;

  for (const field of REPEATED_NATIVE_FIELDS) {
    if (field === "client_metadata") continue;
    if (!hasOwn(frame, field)) continue;
    const expected = expectedField(field, initialIngressFrame, canonicalBody);
    if (!expected.present || !sameJson(expected.value, frame[field])) return {
      error: `continuation response.create changed ${field}; a fresh canonical request is required`,
    };
  }
  const metadata = continuationMetadata(initialIngressFrame, canonicalBody, frame);
  if (metadata.error) return { error: metadata.error };
  if (metadata.present) next.client_metadata = metadata.value;
  else delete next.client_metadata;
  next.type = "response.create";
  return { frame: next };
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

function errorPayload(code: string, message: string, status = 400): Record<string, unknown> {
  return {
    type: "error",
    // The native Responses WebSocket reader requires status to surface a wrapped error.
    // Without it, a rejected tool continuation is ignored and the turn waits indefinitely.
    status,
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
  private successorCreateSent = false;
  private steeringInFlight = false;
  private steeringAccepted = false;
  private steeringLeaseOwned = false;
  private currentResponseId: string | undefined;
  private readonly responseIds = new Set<string>();
  private turnLease: NativeResponsesTurnLease | undefined;
  private readonly continuationControllers = new Set<AbortController>();
  private readonly canonicalBody: Record<string, unknown> | undefined;
  private readonly metadata: CodexWsMetadata;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private startResolve: ((result: NativeResponsesWsStartResult) => void) | undefined;
  private startSettled = false;
  private bodyClosed = false;

  constructor(private readonly options: NativeResponsesWsStartOptions) {
    this.turnLease = options.turnLease;
    this.canonicalBody = parseBodyRecord(options.request.body);
    this.metadata = new CodexWsMetadata(options.onCodexWsQuota);
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
    // The canonical caller will continue with its HTTP/SSE fallback using the same admission
    // lease. Retire this session without releasing that lease, and make any late platform open
    // callback a no-op so it cannot send a second response.create after fallback has started.
    this.closed = true;
    this.metadata.finish();
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    const clientKey = this.options.client as object;
    pendingSessions.delete(clientKey);
    this.closeUpstream(1000, "native transport fallback");
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
    this.metadata.finish();
    try { this.controller?.close(); } catch { /* already closed */ }
    const clientKey = this.options.client as object;
    activeSessions.delete(clientKey);
    pendingSessions.delete(clientKey);
    this.releaseTurnLease();
  }

  private releaseTurnLease(): void {
    const lease = this.turnLease;
    this.turnLease = undefined;
    this.steeringLeaseOwned = false;
    try { lease?.release(); } catch { /* admission release is idempotent */ }
  }

  private acquireTurnLease(): boolean {
    if (this.turnLease) return true;
    const lease = this.options.acquireTurnLease?.();
    if (!lease) return false;
    this.turnLease = lease;
    this.steeringLeaseOwned = false;
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
    const frameText = normalizeCreateFrame(this.options.request.body, this.options.modelId, this.options.initialIngressFrame);
    if (!frameText || frameBytes(frameText) > (this.options.maxCreateFrameBytes ?? NATIVE_WS_MAX_CREATE_FRAME_BYTES)) {
      this.failOpened("message_too_large", "Native Responses WebSocket response.create frame is too large");
      this.resolveStarted();
      return;
    }
    try {
      // The socket is open before this send. A throw is therefore ambiguous and must not fall back
      // to HTTP/SSE, even though no response event has arrived yet.
      this.options.onInitialSend?.();
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
    let relayText: string;
    try {
      const sanitized = this.metadata.consume(event, frameBytes(text));
      if (sanitized !== null) {
        relayText = sanitized;
      } else {
        this.metadata.commit();
        // SSE data fields end at the first newline. Pretty-printed upstream JSON
        // must be compacted before wrapping, or the WS pump sees `data: {` and
        // 502s the native turn.
        relayText = JSON.stringify(event);
      }
    } catch {
      this.failOpened("upstream_metadata_error", "Native Responses WebSocket metadata exceeded its size limit");
      return;
    }
    if (!this.enqueueEvent(relayText)) return;
    const type = eventType(event);
    if (type === "response.created") {
      const id = responseIdFromEvent(event);
      const successor = id !== undefined && this.currentResponseId !== undefined && id !== this.currentResponseId;
      if (id) {
        this.currentResponseId = id;
        this.responseIds.add(id);
      }
      this.activeResponse = true;
      if (successor || !this.steeringInFlight) this.awaitingSuccessor = false;
      if (successor) {
        this.steeringInFlight = false;
        this.steeringAccepted = false;
        this.successorCreateSent = false;
      }
      return;
    }
    if (type === "response.steer.accepted") {
      // Accepted only means queued. Keep the turn unresolved until the successor reaches a
      // terminal event; a disconnect in this interval must surface a failure and never replay.
      this.steeringAccepted = true;
      this.awaitingSuccessor = true;
      return;
    }
    if (type === "response.steer.pending") {
      if (!this.successorCreateSent) this.activeResponse = false;
      this.awaitingSuccessor = true;
      this.steeringInFlight = false;
      this.steeringAccepted = false;
      if (this.steeringLeaseOwned) this.releaseTurnLease();
      return;
    }
    if (type === "response.steer.failed") {
      // A failed steering request did not create a successor turn. Release the
      // short-lived admission acquired for the control frame while preserving the original
      // active response admission when the steer was sent during that response.
      const preserveActiveResponseLease = this.activeResponse;
      const preserveQueuedSuccessor = this.successorCreateSent;
      this.steeringInFlight = false;
      this.steeringAccepted = false;
      this.awaitingSuccessor = preserveQueuedSuccessor;
      if (this.steeringLeaseOwned || (!preserveActiveResponseLease && !preserveQueuedSuccessor)) this.releaseTurnLease();
      return;
    }
    if (!RESPONSE_TERMINAL_TYPES.has(type ?? "")) return;
    const steered = type === "response.incomplete" && incompleteReason(event) === "steered";
    this.activeResponse = false;
    this.awaitingSuccessor = steered || this.awaitingSuccessor || this.steeringInFlight || this.steeringAccepted;
    if (!this.awaitingSuccessor) this.releaseTurnLease();
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
    if (this.activeResponse || this.awaitingSuccessor || this.steeringInFlight || !this.currentResponseId) {
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
      const text = stringifyFrame(frame);
      if (!text || frameBytes(text) > (this.options.maxFrameBytes ?? NATIVE_WS_MAX_FRAME_BYTES)) {
        this.enqueueEvent(JSON.stringify(errorPayload("message_too_large", "WebSocket control frame is too large", 413)));
        return true;
      }
      const hadLease = this.turnLease !== undefined;
      if (!this.acquireTurnLease()) {
        this.enqueueEvent(JSON.stringify({ type: "response.steer.failed", error: { code: "server_busy", message: "active turns capacity reached" } }));
        return true;
      }
      this.steeringInFlight = true;
      this.steeringAccepted = false;
      this.steeringLeaseOwned = !hadLease;
      return this.sendRawUpstream(text, "steering_send_failed");
    }
    if (type === "response.create") {
      // A completed request can be followed by a new, self-contained request on
      // the same client socket (notably after standard compaction). Do not reuse
      // the previous prepared instructions/account for that independent request.
      // Return it to handleResponses so routing, authorization and normalization
      // run again. Linked continuations and pending steering remain on this
      // session and retain their existing strict checks and no-replay contract.
      if (!this.activeResponse && !this.awaitingSuccessor && !this.steeringInFlight
        && !this.steeringAccepted && !hasOwn(frame, "previous_response_id")
        && typeof frame.model === "string" && frame.model.trim().length > 0
        && typeof frame.instructions === "string" && hasOwn(frame, "input")) {
        this.close(1000, "independent request requires canonical preparation");
        return false;
      }
      const model = frame.model;
      const ingressModel = this.options.initialIngressFrame.model;
      const expectedModel = typeof ingressModel === "string" && ingressModel.trim()
        ? ingressModel
        : this.options.modelId;
      if (typeof model === "string" && model.trim() && model !== expectedModel) {
        this.enqueueEvent(JSON.stringify(errorPayload("model_change_unsupported", "A native Responses WebSocket session cannot change model")));
        return true;
      }
      const canQueueWhileSteering = this.steeringInFlight || this.steeringAccepted || this.awaitingSuccessor;
      if (this.activeResponse && !canQueueWhileSteering) {
        this.enqueueEvent(JSON.stringify(errorPayload("response_active", "response.create cannot replace an active native response", 409)));
        return true;
      }
      const previous = frame.previous_response_id;
      if (previous !== undefined && (typeof previous !== "string" || !this.responseIds.has(previous))) {
        this.enqueueEvent(JSON.stringify(errorPayload("unknown_previous_response", "previous_response_id is not known on this native WebSocket session")));
        return true;
      }
      const prepared = prepareContinuationFrame(
        frame,
        this.options.modelId,
        this.options.initialIngressFrame,
        this.canonicalBody,
      );
      if (!prepared.frame) {
        this.enqueueEvent(JSON.stringify(errorPayload(
          prepared.inputError ? "continuation_input_unsupported" : "continuation_preparation_unsupported",
          prepared.error ?? "continuation response.create cannot be reused on the prepared native session",
        )));
        return true;
      }
      const text = stringifyFrame(prepared.frame);
      if (!text || frameBytes(text) > (this.options.maxCreateFrameBytes ?? NATIVE_WS_MAX_CREATE_FRAME_BYTES)) {
        this.enqueueEvent(JSON.stringify(errorPayload("message_too_large", "response.create frame is too large", 413)));
        return true;
      }
      if (!this.acquireTurnLease()) {
        this.enqueueEvent(JSON.stringify(errorPayload("server_busy", "active turns capacity reached", 503)));
        return true;
      }
      // Once a continuation has been accepted, any lease acquired for a post-terminal steer is
      // now carrying the actual successor work. A later response.steer.pending notification must
      // not release it underneath that response, even when the notification races the create.
      this.successorCreateSent = canQueueWhileSteering;
      this.steeringLeaseOwned = false;
      this.activeResponse = true;
      this.awaitingSuccessor = canQueueWhileSteering;
      return this.sendRawUpstream(text, "create_send_failed");
    }
    if (type === "response.cancel") {
      if (!this.activeResponse) {
        this.enqueueEvent(JSON.stringify(errorPayload("response_not_active", "response.cancel has no active response", 409)));
        return true;
      }
      return this.sendClientFrame(frame, "cancel_send_failed");
    }
    return false;
  }

  private sendClientFrame(frame: Record<string, unknown>, failureCode: string): boolean {
    const text = stringifyFrame(frame);
    if (!text || frameBytes(text) > (this.options.maxFrameBytes ?? NATIVE_WS_MAX_FRAME_BYTES)) {
      this.enqueueEvent(JSON.stringify(errorPayload("message_too_large", "WebSocket control frame is too large", 413)));
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
