import { contextSessionDigest } from "./context-management";

// The native client transports one opaque result. Unpack it into native encrypted
// content items on the next Responses request, without decrypting or caching history.
const PREFIX = "ocx-context-history-v1:";
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
interface HistoryBundle {
  session: string;
  outputs: string[];
  unavailable: number;
}

export function bundleContextHistoryOutputs(sessionId: string, outputs: string[], unavailable: number): string {
  const body = JSON.stringify({ session: contextSessionDigest(sessionId), outputs, unavailable });
  if (Buffer.byteLength(body) > MAX_BUNDLE_BYTES) throw new Error("Context history results exceeded the size limit");
  return PREFIX + Buffer.from(body).toString("base64url");
}

export function expandContextHistoryOutputs(body: unknown, sessionId: string): void {
  if (!body || typeof body !== "object") return;
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) return;
  let expandedBytes = 0;
  for (const item of input) {
    if (item?.type !== "function_call_output" || !Array.isArray(item.output)) continue;
    item.output = item.output.flatMap((part: unknown) => {
      if (!part || typeof part !== "object") return [part];
      const content = part as { type?: string; encrypted_content?: unknown };
      if (content.type !== "encrypted_content" || typeof content.encrypted_content !== "string"
        || !content.encrypted_content.startsWith(PREFIX)) return [part];
      if (content.encrypted_content.length > MAX_BUNDLE_BYTES * 2) throw new Error("Context history bundle exceeded the size limit");
      const decoded = Buffer.from(content.encrypted_content.slice(PREFIX.length), "base64url");
      expandedBytes += decoded.length;
      if (expandedBytes > MAX_BUNDLE_BYTES) throw new Error("Context history bundles exceeded the size limit");
      const bundle = JSON.parse(decoded.toString()) as HistoryBundle;
      if (bundle.session !== contextSessionDigest(sessionId) || !Array.isArray(bundle.outputs)
        || bundle.outputs.length > 16 || !Number.isInteger(bundle.unavailable)
        || bundle.unavailable < 0 || bundle.unavailable > 16
        || bundle.outputs.some(output => typeof output !== "string" || !output || output.startsWith(PREFIX))) {
        throw new Error("Invalid context history bundle");
      }
      return [
        { type: "input_text", text: `History spans ${bundle.outputs.length} available storage segments. Results can overlap; deduplicate by window and item IDs.${bundle.unavailable ? ` ${bundle.unavailable} segments are unavailable; this result is partial.` : ""}` },
        ...bundle.outputs.map(encrypted_content => ({ type: "encrypted_content", encrypted_content })),
      ];
    });
  }
}
