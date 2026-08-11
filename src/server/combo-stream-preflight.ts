import { formatErrorResponse, type ResponsesTerminalStatus } from "../bridge";
import {
  createSseInspector,
  isNativePassthroughSseResponse,
  markNativePassthroughSseResponse,
} from "./relay";

const DEFAULT_MAX_PREFLIGHT_BYTES = 1024 * 1024;

export type ComboStreamPreflightResult =
  | { kind: "unchanged"; response: Response }
  | { kind: "commit"; response: Response }
  | { kind: "failure"; response: Response }
  | { kind: "cancelled" };

function replayPrefix(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        try { controller.error(error); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
}

function replayedResponse(
  response: Response,
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return markNativePassthroughSseResponse(new Response(replayPrefix(chunks, reader), {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

/**
 * Hold a native Responses SSE combo child until it either produces model output or
 * terminates. This is the last safe failover boundary: before the prefix is exposed,
 * a terminal failure can move to the next target without duplicating visible output.
 */
export async function preflightNativeComboStream(
  response: Response,
  signal?: AbortSignal,
  maxBytes = DEFAULT_MAX_PREFLIGHT_BYTES,
): Promise<ComboStreamPreflightResult> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok
    || !response.body
    || !contentType.includes("text/event-stream")
    || !isNativePassthroughSseResponse(response)) {
    return { kind: "unchanged", response };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let firstOutput = false;
  let terminal: ResponsesTerminalStatus | undefined;
  let terminalHttpStatus: number | undefined;
  const inspector = createSseInspector({
    onFirstOutput: () => { firstOutput = true; },
    onTerminal: (status, httpStatusOverride) => {
      terminal = status;
      terminalHttpStatus = httpStatusOverride;
    },
  });

  const fail = async (message: string): Promise<ComboStreamPreflightResult> => {
    inspector.dispose();
    await reader.cancel(message).catch(() => {});
    return {
      kind: "failure",
      response: formatErrorResponse(
        terminalHttpStatus && terminalHttpStatus >= 400 ? terminalHttpStatus : 502,
        "upstream_error",
        message,
      ),
    };
  };

  while (true) {
    if (signal?.aborted) {
      inspector.dispose();
      await reader.cancel(signal.reason).catch(() => {});
      return { kind: "cancelled" };
    }

    let next;
    try {
      next = await reader.read();
    } catch (error) {
      return fail(error instanceof Error ? error.message : "combo stream failed before output");
    }
    if (next.done) {
      inspector.finish();
      if (terminal === "completed") {
        inspector.dispose();
        return { kind: "commit", response: replayedResponse(response, chunks, reader) };
      }
      return fail("combo stream ended before producing output");
    }

    retainedBytes += next.value.byteLength;
    if (retainedBytes > maxBytes) {
      return fail("combo stream preflight exceeded the safe buffer limit");
    }
    chunks.push(next.value);
    inspector.feed(next.value);

    if (terminal === "failed" || terminal === "incomplete") {
      return fail(`combo stream terminated with ${terminal} before output was committed`);
    }
    if (firstOutput || terminal === "completed") {
      inspector.dispose();
      return { kind: "commit", response: replayedResponse(response, chunks, reader) };
    }
  }
}
