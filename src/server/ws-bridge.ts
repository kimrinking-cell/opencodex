import type { ServerWebSocket } from "bun";
import { responsesJsonEventSequence } from "./responses-json-events";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import type { CodexAuthContext } from "../codex/auth-context";
import { headersForCodexAuthContext } from "../codex/auth-context";
import type { ResponsesTerminalStatus } from "../bridge";
import type { DataPlaneAdmission } from "./auth-cors";
import type { AdmissionLease, AdmissionReservation } from "../lib/admission";
import { BoundedSseFrameBuffer } from "./sse-frame-buffer";
import { sseFieldValue } from "../lib/sse-decoder";
import { safeResponseHeaders } from "./safe-response-headers";

export { safeResponseHeaders } from "./safe-response-headers";

const OPEN = 1;
type ResponsesTerminalReporter = (status: ResponsesTerminalStatus) => void;
type ResponsesPayloadObserver = (payload: string) => void;

export interface WsData {
  headers?: Headers; // base inbound forward headers only; per-turn auth refresh injects current pool tokens
  /**
   * Resolved once at the handshake. Auth is handshake-time only on this path, so
   * the per-frame log contexts have no request headers left to re-resolve from.
   * Optional like every other member here: a socket object can exist before the
   * handshake fills it, and an unattributed frame is preferable to a fabricated
   * attribution.
   */
  admission?: DataPlaneAdmission;
  authContext?: CodexAuthContext; // last resolved account decision for observability/registry cleanup
  cancel?: () => void; // cancels the in-flight stream reader/fetch
  turnId?: number; // monotonically increasing per socket; prevents stale frames after replacement turns
  /** Fixed-size logical session lane derived at the HTTP upgrade boundary. */
  sessionLaneId?: string;
  /** Discriminator: Responses reframing vs transparent live/realtime sideband relay. */
  kind?: "responses" | "live-sideband";
  liveUpstream?: WebSocket;
  liveUpstreamUrl?: string;
  liveUpstreamHeaders?: Record<string, string>;
  livePending?: Array<string | Buffer>;
  /** Total encoded bytes retained in livePending while the upstream connects. */
  livePendingBytes?: number;
  liveOpened?: boolean;
  /** Once teardown starts, ignore new client frames until the upstream closes. */
  liveClosing?: boolean;
  /** Schedules one bounded close retry without surrendering native-main ownership. */
  liveCloseFallback?: ReturnType<typeof setTimeout>;
  /** Turn/account ownership retained for the complete sideband socket lifetime. */
  liveTurnAdmissionLease?: AdmissionLease;
  admissionLease?: AdmissionReservation<ServerWebSocket<WsData>>;
}

/**
 * Build the Responses WebSocket upgrade payload.
 *
 * Extracted so the handshake's contract is testable: `server.upgrade` hands its
 * `data` straight to the socket, and a client has no way to read `ws.data` back.
 * A test that only asserts "the socket opened" would still pass if the admission
 * were dropped from the payload, so the payload itself is what gets asserted.
 */
export function buildResponsesWsData(
  headers: Headers,
  admission: DataPlaneAdmission,
  admissionLease?: AdmissionReservation<ServerWebSocket<WsData>>,
  sessionLaneId?: string,
): WsData {
  // Auth is handshake-time only on this path: the per-frame contexts have no
  // request headers left to re-resolve from, so the decision rides along here.
  return {
    headers,
    admission,
    ...(admissionLease ? { admissionLease } : {}),
    ...(sessionLaneId ? { sessionLaneId } : {}),
  };
}

export class WsSendDroppedError extends Error {
  constructor() {
    super("websocket send dropped the message");
  }
}

export function selectForwardHeaders(
  headers: Headers,
  codexOverride?: { accessToken: string; chatgptAccountId: string },
): Headers {
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value) selected.set(name, value);
  }
  if (codexOverride) {
    selected.set("authorization", `Bearer ${codexOverride.accessToken}`);
    selected.set("chatgpt-account-id", codexOverride.chatgptAccountId);
  }
  return selected;
}

export function selectForwardHeadersForAuthContext(headers: Headers, ctx: CodexAuthContext): Headers {
  return headersForCodexAuthContext(headers, ctx);
}

export function buildWarmupCompletionFrames(frame: Record<string, unknown>): string[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const baseResponse: Record<string, unknown> = {
    id: "",
    object: "response",
    created_at: createdAt,
    model: typeof frame.model === "string" ? frame.model : undefined,
    output: [],
  };
  return [
    JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: { ...baseResponse, status: "in_progress" },
    }),
    JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: { ...baseResponse, status: "completed" },
    }),
  ];
}

export function sendTextFrame(ws: ServerWebSocket<WsData>, payload: string): void {
  if (ws.readyState !== OPEN) throw new WsSendDroppedError();
  const result = ws.send(payload);
  if (result === 0) throw new WsSendDroppedError();
  // Bun returns -1 when queued with backpressure. That is accepted; a later 0 is the hard failure.
}

export function sendJsonFrame(ws: ServerWebSocket<WsData>, payload: Record<string, unknown>): void {
  sendTextFrame(ws, JSON.stringify(payload));
}

export function buildWsErrorFrame(
  status: number,
  error: Record<string, unknown>,
  headers?: Headers,
): Record<string, unknown> {
  return {
    type: "error",
    status,
    error,
    headers: headers ? safeResponseHeaders(headers) : {},
  };
}

function jsonParses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function parseSseBlock(block: string): { event?: string; payload: string } | null {
  const data: string[] = [];
  const continuation: string[] = [];
  let event: string | undefined;
  let seenData = false;
  for (const line of block.split(/\r?\n/)) {
    const eventValue = sseFieldValue(line, "event");
    if (eventValue !== null) {
      event = eventValue;
      continue;
    }
    if (sseFieldValue(line, "id") !== null || sseFieldValue(line, "retry") !== null) continue;
    if (line.startsWith(":")) continue;
    const dataValue = sseFieldValue(line, "data");
    if (dataValue !== null) {
      seenData = true;
      data.push(dataValue);
      continue;
    }
    if (seenData) continuation.push(line);
  }
  if (data.length === 0) return null;
  let payload = data.join("\n");
  // `data: ${prettyJson}\n\n` is invalid SSE: the first newline ends the field, so the
  // payload becomes `{`. Rejoin following non-field lines when that recovers JSON.
  if (continuation.length > 0) {
    const recovered = [payload, ...continuation].join("\n");
    if (!jsonParses(payload) && jsonParses(recovered)) payload = recovered;
  }
  return event ? { event, payload } : { payload };
}

type ClassifiedResponsesSsePayload =
  | { kind: "done" }
  | { kind: "skip" }
  | { kind: "invalid" }
  | { kind: "event"; type: string; forward: string };

function classifyResponsesSsePayload(payload: string, eventName?: string): ClassifiedResponsesSsePayload {
  const trimmed = payload.trim();
  if (trimmed === "[DONE]") return { kind: "done" };
  if (trimmed.length === 0) return { kind: "skip" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "invalid" };
  }
  // Protocol V1 padding: null, scalar, and array data values are keepalives, not events.
  // Treating them as a 502 used to abort Codex native steering mid-turn (#1219 class).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "skip" };
  const record = parsed as Record<string, unknown>;
  if (typeof record.type === "string" && record.type.length > 0) {
    return {
      kind: "event",
      type: record.type,
      forward: /[\r\n]/.test(payload) ? JSON.stringify(record) : payload,
    };
  }
  if (eventName && eventName.length > 0) {
    return { kind: "event", type: eventName, forward: JSON.stringify({ ...record, type: eventName }) };
  }
  return { kind: "skip" };
}

function terminalStatusFromType(type: string): ResponsesTerminalStatus | null {
  switch (type) {
    case "response.completed":
      return "completed";
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return "incomplete";
    default:
      return null;
  }
}

function protocolError(message: string): Record<string, unknown> {
  return {
    type: "protocol_error",
    code: "websocket_protocol_error",
    message,
  };
}

function sendProtocolError(ws: ServerWebSocket<WsData>, status: number, message: string): void {
  sendJsonFrame(ws, buildWsErrorFrame(status, protocolError(message)));
}

export async function pumpResponsesSseToWebSocket(
  ws: ServerWebSocket<WsData>,
  sseStream: ReadableStream<Uint8Array>,
  options: {
    isCurrent?: () => boolean;
    onTerminal?: ResponsesTerminalReporter;
    onSsePayload?: ResponsesPayloadObserver;
    /** Native Astra keeps one upstream socket alive across terminal events. */
    keepAliveAfterTerminal?: boolean;
  } = {},
): Promise<void> {
  const reader = sseStream.getReader();
  const isCurrent = options.isCurrent ?? (() => true);
  let clientCancelled = false;
  let terminalReported = false;
  let sawTerminal = false;
  const keepAliveAfterTerminal = options.keepAliveAfterTerminal === true;
  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported || clientCancelled || !isCurrent()) return;
    terminalReported = true;
    options.onTerminal?.(status);
  };
  const cancel = () => {
    clientCancelled = true;
    void reader.cancel().catch(() => {});
  };
  ws.data.cancel = cancel;

  const decoder = new TextDecoder();
  const framer = new BoundedSseFrameBuffer();
  let terminalSeen = false;

  const handlePayload = (payload: string, eventName?: string): boolean => {
    if (!isCurrent()) return true;
    const classified = classifyResponsesSsePayload(payload, eventName);
    if (classified.kind === "done" || classified.kind === "skip") return false;
    try {
      options.onSsePayload?.(payload);
    } catch {
      /* payload observation must not affect WebSocket delivery */
    }
    if (classified.kind === "invalid") {
      // After a native Astra terminal the pump stays open for steering. A junk
      // padding frame must not 502 a host-observed turn that cannot be replayed.
      if (sawTerminal) return false;
      reportTerminal("incomplete");
      sendProtocolError(ws, 502, "Invalid JSON payload in upstream SSE frame");
      terminalSeen = true;
      void reader.cancel().catch(() => {});
      return true;
    }
    if (terminalSeen && !keepAliveAfterTerminal) return true;
    sendTextFrame(ws, classified.forward);
    const terminalStatus = terminalStatusFromType(classified.type);
    if (terminalStatus) {
      sawTerminal = true;
      reportTerminal(terminalStatus);
      if (!keepAliveAfterTerminal) {
        terminalSeen = true;
        void reader.cancel().catch(() => {});
        return true;
      }
    }
    return false;
  };

  try {
    while (!terminalSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of framer.feed(value)) {
        const parsed = parseSseBlock(decoder.decode(frame.block));
        if (parsed && handlePayload(parsed.payload, parsed.event)) break;
      }
    }
    const tail = framer.finish();
    if (!terminalSeen && tail.byteLength > 0) {
      const parsed = parseSseBlock(decoder.decode(tail));
      if (parsed) handlePayload(parsed.payload, parsed.event);
    }
    if (!terminalSeen && !sawTerminal && isCurrent() && !clientCancelled) {
      reportTerminal("incomplete");
      sendProtocolError(ws, 502, "Upstream stream ended before response terminal event");
    }
  } catch (err) {
    framer.dispose();
    if (err instanceof WsSendDroppedError) throw err;
    if (!terminalSeen
      && isCurrent()
      && ws.readyState === OPEN
      && !(err instanceof WsSendDroppedError)) {
      reportTerminal("incomplete");
      try {
        sendProtocolError(ws, 502, err instanceof Error ? err.message : String(err));
      } catch (sendErr) {
        // If delivery is already dropped, there is no useful error frame left
        // to send. Swallow only that expected transport signal; other failures
        // still surface to the caller after the upstream reader is released.
        if (!(sendErr instanceof WsSendDroppedError)) throw sendErr;
      }
    }
  } finally {
    framer.dispose();
    // Framing errors can occur while the upstream body is still live. Always
    // release the reader, even when terminal/send paths already cancelled it.
    void reader.cancel().catch(() => {});
    if (ws.data.cancel === cancel) ws.data.cancel = undefined;
  }
}

export function sendResponsesJsonAsEvents(
  ws: ServerWebSocket<WsData>,
  response: Record<string, unknown>,
  onTerminal?: ResponsesTerminalReporter,
  onPayload?: ResponsesPayloadObserver,
): void {
  const sendObservedFrame = (payload: Record<string, unknown>) => {
    const text = JSON.stringify(payload);
    try {
      onPayload?.(text);
    } catch {
      /* payload observation must not affect WebSocket delivery */
    }
    sendTextFrame(ws, text);
  };
  const finalStatus = response.status === "failed" || response.status === "incomplete"
    ? response.status
    : "completed";
  for (const frame of responsesJsonEventSequence(response)) {
    sendObservedFrame(frame);
  }
  onTerminal?.(finalStatus);
}

function errorPayloadFromText(text: string): Record<string, unknown> {
  try {
    const json = JSON.parse(text) as { error?: unknown };
    if (json.error && typeof json.error === "object" && !Array.isArray(json.error)) {
      return json.error as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {
    type: "upstream_error",
    message: text ? text.slice(0, 500) : "Upstream request failed",
  };
}

export async function sendResponseToWebSocket(
  ws: ServerWebSocket<WsData>,
  response: Response,
  isCurrent: () => boolean,
  options: {
    onTerminal?: ResponsesTerminalReporter;
    onSsePayload?: ResponsesPayloadObserver;
    keepAliveAfterTerminal?: boolean;
  } = {},
): Promise<void> {
  if (!isCurrent()) {
    await response.body?.cancel().catch(() => {});
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (!isCurrent()) return;
    sendJsonFrame(ws, buildWsErrorFrame(response.status, errorPayloadFromText(text), response.headers));
    return;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body) {
    options.onTerminal?.("incomplete");
    sendJsonFrame(ws, buildWsErrorFrame(502, {
      type: "protocol_error",
      code: "websocket_protocol_error",
      message: `Unexpected successful upstream response without a body (${response.status})`,
    }, response.headers));
    return;
  }

  if (contentType.includes("text/event-stream")) {
    await pumpResponsesSseToWebSocket(ws, response.body, {
      isCurrent,
      onTerminal: options.onTerminal,
      onSsePayload: options.onSsePayload,
      keepAliveAfterTerminal: options.keepAliveAfterTerminal,
    });
    return;
  }

  if (contentType.includes("application/json")) {
    const text = await response.text();
    if (!isCurrent()) return;
    const json = JSON.parse(text) as Record<string, unknown>;
    sendResponsesJsonAsEvents(ws, json, options.onTerminal, options.onSsePayload);
    return;
  }

  const { prefix, stream } = await readBoundedPrefix(response.body);
  if (!isCurrent()) {
    await stream.cancel().catch(() => {});
    return;
  }
  if (looksLikeSse(prefix)) {
    await pumpResponsesSseToWebSocket(ws, stream, {
      isCurrent,
      onTerminal: options.onTerminal,
      onSsePayload: options.onSsePayload,
      keepAliveAfterTerminal: options.keepAliveAfterTerminal,
    });
    return;
  }

  const text = await new Response(stream).text();
  if (!isCurrent()) return;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    sendResponsesJsonAsEvents(ws, json, options.onTerminal, options.onSsePayload);
    return;
  }

  options.onTerminal?.("incomplete");
  sendJsonFrame(ws, buildWsErrorFrame(502, {
    type: "protocol_error",
    code: "websocket_protocol_error",
    message: `Unexpected successful non-SSE upstream response (${contentType || "missing content-type"})`,
  }, response.headers));
}

export async function readBoundedPrefix(
  body: ReadableStream<Uint8Array>,
  maxBytes = 4096,
): Promise<{ prefix: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let remainder: Uint8Array | undefined;
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, maxBytes - total);
    if (take > 0) {
      chunks.push(value.slice(0, take));
      total += take;
    }
    if (take < value.byteLength) {
      remainder = value.slice(take);
      break;
    }
  }
  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength > 0) controller.enqueue(prefix);
      if (remainder && remainder.byteLength > 0) controller.enqueue(remainder);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix, stream };
}

export function looksLikeSse(prefix: Uint8Array): boolean {
  const text = new TextDecoder().decode(prefix);
  return /^\s*(event:|data:)/.test(text);
}
