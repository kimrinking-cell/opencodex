import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { REPORT_MODELS } from "./context-failure-report";
import { resolveCodexStateDbPath } from "./paths";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^[a-f0-9]{32}$/;
const MAX_STATE_BYTES = 4096;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_MS = 2_000;
const SCAN_CHUNK_BYTES = 64 * 1024;
const LINE_BOUNDARY_BYTES = 64 * 1024;
const MAX_CHECKPOINT_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const BACKEND_REQUEST_FAILURE = "Unable to perform operation: The backend request failed.";
const CONTINUITY_NOTE_PATH = "continuity/current.md";
const CHECKPOINT_FIELDS = ["goal", "user_constraints", "verified_state", "next_action"] as const;

interface ContinuityCheckpoint {
  version: 1;
  checkpoint_id: string;
  thread_id: string;
  model: string;
  source_window_id: string;
  token_hash: string;
  issued_at: string;
  rollout_identity: string;
  rollout_offset: number;
  simulation: boolean;
}

interface TransitionEvidence {
  complete: boolean;
  validRecords: number;
  transitionCount: number;
  latestWindowId: string | null;
  sourceIsAncestor: boolean;
  checkpointWriteCompleted: boolean;
  checkpointReadbackCompleted: boolean;
  recoveryReadCompleted: boolean;
  taskActionCompleted: boolean;
}

export interface ContinuityCheckpointResult {
  issued: boolean;
  checkpoint_id: string;
  token: string;
  source_window_id: string;
}

export interface ContinuityVerificationResult {
  recorded: boolean;
  duplicate: boolean;
  status: "verified" | "inconclusive";
  reason?: string;
  file?: string;
}

interface ResolvedRollout {
  path: string;
  identity: string;
  offset: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireThreadId(env: NodeJS.ProcessEnv): string {
  const thread = env.CODEX_THREAD_ID ?? "";
  if (!UUID.test(thread)) throw new Error("A current Codex thread is required");
  return thread;
}

function validateModelAndWindow(model: string, window: string): void {
  if (!(REPORT_MODELS as readonly string[]).includes(model) || !UUID.test(window)) {
    throw new Error("Invalid context continuity fields");
  }
}

function stableRolloutOffset(path: string): number {
  const size = statSync(path).size;
  if (size === 0) return 0;
  const length = Math.min(size, LINE_BOUNDARY_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    const bytes = readSync(fd, buffer, 0, length, size - length);
    const lastNewline = buffer.subarray(0, bytes).lastIndexOf(0x0a);
    if (lastNewline < 0) throw new Error("The current rollout has no bounded line boundary");
    return size - length + lastNewline + 1;
  } finally {
    closeSync(fd);
  }
}

function resolveCurrentThreadRollout(threadId: string, env: NodeJS.ProcessEnv): ResolvedRollout {
  let database: Database | undefined;
  try {
    database = new Database(resolveCodexStateDbPath({ codexHome: env.CODEX_HOME, env }), { readonly: true });
    const row = database.query<{ rollout_path: string }, [string]>(
      "SELECT rollout_path FROM threads WHERE id = ? LIMIT 1",
    ).get(threadId);
    if (!row || typeof row.rollout_path !== "string" || !isAbsolute(row.rollout_path)
      || row.rollout_path.includes("\u0000")) throw new Error("The current rollout is unavailable");
    const stat = statSync(row.rollout_path);
    if (!stat.isFile()) throw new Error("The current rollout is unavailable");
    return {
      path: row.rollout_path,
      identity: digest(`${stat.dev}:${stat.ino}`),
      offset: stableRolloutOffset(row.rollout_path),
    };
  } finally {
    try { database?.close(); } catch { /* read-only lookup */ }
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function atomicWritePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function checkpointPath(directory: string, threadId: string): string {
  return join(directory, "state", `${digest(threadId)}.json`);
}

function readCheckpoint(directory: string, threadId: string): ContinuityCheckpoint {
  const path = checkpointPath(directory, threadId);
  if (statSync(path).size > MAX_STATE_BYTES) throw new Error("Invalid continuity checkpoint");
  const value = JSON.parse(readFileSync(path, "utf8")) as ContinuityCheckpoint;
  if (value.version !== 1 || value.thread_id !== threadId || !UUID.test(value.source_window_id)
    || !(REPORT_MODELS as readonly string[]).includes(value.model)
    || !/^[a-f0-9]{64}$/.test(value.token_hash) || !/^[a-f0-9]{64}$/.test(value.rollout_identity)
    || !/^[a-f0-9]{64}$/.test(value.checkpoint_id) || !Number.isSafeInteger(value.rollout_offset)
    || value.rollout_offset < 0 || !Number.isFinite(Date.parse(value.issued_at))) {
    throw new Error("Invalid continuity checkpoint");
  }
  return value;
}

export function issueContinuityCheckpoint(
  directory: string,
  model: string,
  window: string,
  env: NodeJS.ProcessEnv = process.env,
): ContinuityCheckpointResult {
  if (!isAbsolute(directory)) throw new Error("An absolute continuity directory is required");
  validateModelAndWindow(model, window);
  const thread = requireThreadId(env);
  const rollout = resolveCurrentThreadRollout(thread, env);
  const token = randomBytes(16).toString("hex");
  const simulation = env.OPENCODEX_CONTEXT_REPORT_TEST === "1";
  const checkpoint: ContinuityCheckpoint = {
    version: 1,
    checkpoint_id: digest(JSON.stringify([thread, window, token, simulation])),
    thread_id: thread,
    model,
    source_window_id: window,
    token_hash: digest(token),
    issued_at: new Date().toISOString(),
    rollout_identity: rollout.identity,
    rollout_offset: rollout.offset,
    simulation,
  };
  ensurePrivateDirectory(join(directory, "state"));
  atomicWritePrivateJson(checkpointPath(directory, thread), checkpoint);
  return { issued: true, checkpoint_id: checkpoint.checkpoint_id, token, source_window_id: window };
}

function parseRecord(line: string): { type?: unknown; timestamp?: unknown; payload?: unknown } | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object"
      ? value as { type?: unknown; timestamp?: unknown; payload?: unknown }
      : null;
  } catch {
    return null;
  }
}

function payloadObject(record: { payload?: unknown }): Record<string, unknown> | null {
  return record.payload && typeof record.payload === "object"
    ? record.payload as Record<string, unknown>
    : null;
}

function callId(payload: Record<string, unknown>): string | null {
  const value = payload.call_id ?? payload.callId ?? payload.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function callName(payload: Record<string, unknown>): string {
  const namespace = typeof payload.namespace === "string" ? payload.namespace : "";
  const name = typeof payload.name === "string" ? payload.name.replace(/^(?:notes|history)\./, "") : "";
  return namespace ? `${namespace}.${name}` : name;
}

function callInput(payload: Record<string, unknown>): string {
  if (typeof payload.input === "string") return payload.input;
  if (typeof payload.arguments === "string") return payload.arguments;
  return "";
}

function isToolCall(payload: Record<string, unknown>): boolean {
  return payload.type === "function_call" || payload.type === "custom_tool_call";
}

function parsedCallArguments(payload: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const value = JSON.parse(callInput(payload)) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isContinuityNoteWrite(payload: Record<string, unknown>, token: string): boolean {
  if (!isToolCall(payload) || callName(payload) !== "notes.write_file") return false;
  const args = parsedCallArguments(payload);
  if (args?.path !== CONTINUITY_NOTE_PATH || typeof args.text !== "string") return false;
  const text = args.text;
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^token:\\s*${escapedToken}\\s*$`, "m").test(text)) return false;
  return CHECKPOINT_FIELDS.every(field => new RegExp(`^${field}:\\s*\\S`, "m").test(text));
}

function isContinuityNoteRead(payload: Record<string, unknown>): boolean {
  if (!isToolCall(payload) || callName(payload) !== "notes.read_file") return false;
  return parsedCallArguments(payload)?.path === CONTINUITY_NOTE_PATH;
}

function isRecoveryRead(payload: Record<string, unknown>): boolean {
  if (isContinuityNoteRead(payload)) return true;
  if (!isToolCall(payload) || callName(payload) !== "history.search_contents") return false;
  const query = parsedCallArguments(payload)?.query;
  return typeof query === "string" && query.includes(CONTINUITY_NOTE_PATH);
}

function isReceiptOrRecoveryControl(payload: Record<string, unknown>): boolean {
  const name = callName(payload);
  const input = callInput(payload);
  if (name === "new_context" || name.endsWith(".new_context") || name === "request_user_input"
    || name.endsWith(".request_user_input") || name === "get_context_remaining"
    || name.endsWith(".get_context_remaining") || name === "get_goal" || name.endsWith(".get_goal")) return true;
  return /context-(?:continuity-receipt|failure-report)\.ts/.test(input);
}

function isTaskAction(payload: Record<string, unknown>): boolean {
  if (!isToolCall(payload) || isReceiptOrRecoveryControl(payload)) return false;
  const name = callName(payload);
  return !name.startsWith("notes.") && !name.startsWith("history.");
}

function isBackendFailure(payload: Record<string, unknown>): boolean {
  if (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") return false;
  if (payload.output === BACKEND_REQUEST_FAILURE) return true;
  return Array.isArray(payload.output) && payload.output.some(block => {
    return !!block && typeof block === "object"
      && (block as Record<string, unknown>).text === BACKEND_REQUEST_FAILURE;
  });
}

function isNativeEncryptedCompletion(payload: Record<string, unknown>): boolean {
  return payload.type === "function_call_output" && Array.isArray(payload.output)
    && payload.output.length > 0 && payload.output.every(block => {
      if (!block || typeof block !== "object") return false;
      const value = block as Record<string, unknown>;
      return value.type === "encrypted_content" && typeof value.encrypted_content === "string"
        && value.encrypted_content.length > 0;
    });
}

async function inspectTransition(
  path: string,
  offset: number,
  sourceWindow: string,
  destinationWindow: string,
  token: string,
): Promise<TransitionEvidence> {
  const evidence: TransitionEvidence = {
    complete: true,
    validRecords: 0,
    transitionCount: 0,
    latestWindowId: null,
    sourceIsAncestor: false,
    checkpointWriteCompleted: false,
    checkpointReadbackCompleted: false,
    recoveryReadCompleted: false,
    taskActionCompleted: false,
  };
  const started = performance.now();
  const predecessors = new Map<string, string>();
  const checkpointWrites = new Set<string>();
  const checkpointReadbacks = new Set<string>();
  const recoveryReads = new Set<string>();
  const taskActions = new Set<string>();
  let afterDestination = false;
  let bytes = 0;
  let carry = "";
  try {
    const stream = createReadStream(path, { start: offset, highWaterMark: SCAN_CHUNK_BYTES });
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + data.byteLength > MAX_SCAN_BYTES || performance.now() - started > MAX_SCAN_MS) {
        evidence.complete = false;
        break;
      }
      bytes += data.byteLength;
      carry += data.toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const record = parseRecord(line);
        if (!record) {
          evidence.complete = false;
          continue;
        }
        evidence.validRecords += 1;
        const payload = payloadObject(record);
        if (!payload) continue;
        if (record.type === "compacted") {
          const window = payload.window_id;
          const previous = payload.previous_window_id;
          if (typeof window === "string" && UUID.test(window)
            && typeof previous === "string" && UUID.test(previous)) {
            predecessors.set(window, previous);
            evidence.transitionCount += 1;
            evidence.latestWindowId = window;
            if (window === destinationWindow) afterDestination = true;
            else if (afterDestination) afterDestination = false;
          }
          continue;
        }
        if (isToolCall(payload)) {
          const id = callId(payload);
          if (!id) continue;
          if (!afterDestination && isContinuityNoteWrite(payload, token)) checkpointWrites.add(id);
          else if (!afterDestination && evidence.checkpointWriteCompleted && isContinuityNoteRead(payload)) {
            checkpointReadbacks.add(id);
          }
          else if (afterDestination && isRecoveryRead(payload)) recoveryReads.add(id);
          else if (afterDestination && evidence.recoveryReadCompleted && isTaskAction(payload)) taskActions.add(id);
          continue;
        }
        if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
          const id = callId(payload);
          if (!id) continue;
          if (checkpointWrites.has(id) && isNativeEncryptedCompletion(payload)) {
            evidence.checkpointWriteCompleted = true;
          }
          if (checkpointReadbacks.has(id) && isNativeEncryptedCompletion(payload)) {
            evidence.checkpointReadbackCompleted = true;
          }
          if (recoveryReads.has(id) && isNativeEncryptedCompletion(payload)) {
            evidence.recoveryReadCompleted = true;
          }
          if (taskActions.has(id) && !isBackendFailure(payload)) evidence.taskActionCompleted = true;
        }
      }
      if (performance.now() - started > MAX_SCAN_MS) {
        evidence.complete = false;
        break;
      }
    }
    if (evidence.complete && carry.trim()) {
      // A live writer may leave one incomplete record at EOF. It cannot safely support a receipt.
      evidence.complete = false;
    }
  } catch {
    evidence.complete = false;
  }
  let cursor = destinationWindow;
  const visited = new Set<string>();
  while (!visited.has(cursor)) {
    visited.add(cursor);
    const previous = predecessors.get(cursor);
    if (!previous) break;
    if (previous === sourceWindow) {
      evidence.sourceIsAncestor = true;
      break;
    }
    cursor = previous;
  }
  return evidence;
}

function tokensMatch(token: string, expectedHash: string): boolean {
  if (!TOKEN.test(token)) return false;
  const actual = Buffer.from(digest(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function inconclusive(reason: string): ContinuityVerificationResult {
  return { recorded: false, duplicate: false, status: "inconclusive", reason };
}

export async function verifyContinuityCheckpoint(
  directory: string,
  model: string,
  window: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContinuityVerificationResult> {
  if (!isAbsolute(directory)) throw new Error("An absolute continuity directory is required");
  validateModelAndWindow(model, window);
  const thread = requireThreadId(env);
  let checkpoint: ContinuityCheckpoint;
  try { checkpoint = readCheckpoint(directory, thread); }
  catch { return inconclusive("checkpoint_unavailable"); }
  if (checkpoint.model !== model) return inconclusive("model_changed");
  if (checkpoint.source_window_id === window) return inconclusive("same_window");
  if (!tokensMatch(token, checkpoint.token_hash)) return inconclusive("token_mismatch");
  const issuedAt = Date.parse(checkpoint.issued_at);
  if (Date.now() - issuedAt > MAX_CHECKPOINT_AGE_MS || issuedAt - Date.now() > 60_000) {
    return inconclusive("checkpoint_stale");
  }
  let rollout: ResolvedRollout;
  try { rollout = resolveCurrentThreadRollout(thread, env); }
  catch { return inconclusive("rollout_unavailable"); }
  if (rollout.identity !== checkpoint.rollout_identity || rollout.offset < checkpoint.rollout_offset) {
    return inconclusive("rollout_changed");
  }
  const evidence = await inspectTransition(
    rollout.path,
    checkpoint.rollout_offset,
    checkpoint.source_window_id,
    window,
    token,
  );
  if (!evidence.complete || evidence.validRecords === 0) return inconclusive("evidence_incomplete");
  if (!evidence.sourceIsAncestor || evidence.latestWindowId !== window) return inconclusive("transition_unverified");
  if (!evidence.checkpointWriteCompleted) {
    return inconclusive("checkpoint_write_unverified");
  }
  if (!evidence.checkpointReadbackCompleted) return inconclusive("checkpoint_readback_unverified");
  if (!evidence.recoveryReadCompleted) {
    return inconclusive("recovery_read_unverified");
  }
  if (!evidence.taskActionCompleted) return inconclusive("task_continuation_unverified");

  const receipts = join(directory, "receipts");
  ensurePrivateDirectory(receipts);
  const receiptId = digest(JSON.stringify([checkpoint.checkpoint_id, window]));
  const file = join(receipts, `${receiptId}.json`);
  const base = {
    version: 1,
    source: "local_context_continuity_guard",
    independently_verified: true,
    verification_scope: "window_transition_exact_checkpoint_roundtrip_and_task_action",
    semantic_task_recovery: "unverified",
    recorded_at: new Date().toISOString(),
    receipt_id: receiptId,
    checkpoint_id: checkpoint.checkpoint_id,
    model,
    thread_id: thread,
    source_window_id: checkpoint.source_window_id,
    destination_window_id: window,
    transition_count: evidence.transitionCount,
    checkpoint_write_observed: true,
    checkpoint_readback_observed: true,
    recovery_read_observed: true,
    task_action_observed: true,
    outcome: "healthy",
    simulation: checkpoint.simulation,
  };
  try {
    writeFileSync(file, `${JSON.stringify(base)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        if (statSync(file).size <= MAX_STATE_BYTES) {
          const previous = JSON.parse(readFileSync(file, "utf8"));
          if (previous.receipt_id === receiptId && previous.checkpoint_id === checkpoint.checkpoint_id
            && previous.destination_window_id === window && previous.outcome === "healthy") {
            return { recorded: true, duplicate: true, status: "verified", file };
          }
        }
      } catch { /* fail closed below */ }
    }
    throw new Error("Context continuity receipt could not be saved locally");
  }
  return { recorded: true, duplicate: false, status: "verified", file };
}

function shellQuote(value: string): string {
  return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function contextContinuityReceiptGuidance(model: string, directory: string): string {
  if (!(REPORT_MODELS as readonly string[]).includes(model)) throw new Error("Unsupported continuity model");
  const script = fileURLToPath(import.meta.url);
  const command = `${process.platform === "win32" ? "& " : ""}${shellQuote(process.execPath)} ${shellQuote(script)}`;
  return `Use passive continuity checkpoints during real work, never synthetic test work. Only when a substantive task reaches a meaningful verified milestone and material work remains, run:\n${command} checkpoint --store ${shellQuote(directory)} --model ${model} --window <Current-context-window-id>\nThen create or replace the native Notes file ${CONTINUITY_NOTE_PATH} with exactly these compact one-line fields:\ntoken: <Returned-token>\ngoal: <Current-goal>\nuser_constraints: <Current-user-constraints>\nverified_state: <Last-verified-state>\nnext_action: <Next-task-action>\nRead that exact file back before continuing. Do not checkpoint greetings, simple explanations, completed work, every turn, elapsed time, or tool-call counts. Do not show the token to the user.\nAfter an actual context reset, before issuing a newer checkpoint, read ${CONTINUITY_NOTE_PATH}; if unavailable, recover the current thread from AgentsView and search Notes for that exact path. Do not use native History tools. If a token is recovered, restore the task, complete one normal task-relevant tool action, then run:\n${command} verify --store ${shellQuote(directory)} --model ${model} --window <Current-context-window-id> --token <Recovered-token>\nA recorded:true verification is mechanically scoped to an observed compacted window chain, an exact-token checkpoint written to and read back from ${CONTINUITY_NOTE_PATH} before reset, a targeted post-reset Notes/History read, exact token recovery, and a completed post-reset task tool action. It does not independently prove semantic task correctness. Keep verified transitions silent. An inconclusive result is not a failure and must not be reported as healthy; continue bounded recovery and use the failure reporter only for a genuine recovery problem. A fresh task, no meaningful checkpoint, no reset, missing token, stale token, same-window verification, incomplete rollout evidence, or corrected harmless tool arguments are not incidents. Never create a success receipt from model confidence or report absence alone.`;
}

type ParsedArgs =
  | { action: "checkpoint"; directory: string; model: string; window: string }
  | { action: "verify"; directory: string; model: string; window: string; token: string };

export function parseContextContinuityArgs(args: string[]): ParsedArgs {
  const action = args[0];
  if (action !== "checkpoint" && action !== "verify") throw new Error("Expected checkpoint or verify");
  const allowed = new Set(action === "checkpoint" ? ["store", "model", "window"] : ["store", "model", "window", "token"]);
  const fields: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    const key = flag.startsWith("--") ? flag.slice(2) : "";
    const value = args[i + 1];
    if (!allowed.has(key) || fields[key] !== undefined || !value || value.startsWith("--")) {
      throw new Error("Invalid context continuity arguments");
    }
    fields[key] = value;
  }
  if (Object.keys(fields).length !== allowed.size) throw new Error("Missing context continuity arguments");
  return action === "checkpoint"
    ? { action, directory: fields.store!, model: fields.model!, window: fields.window! }
    : { action, directory: fields.store!, model: fields.model!, window: fields.window!, token: fields.token! };
}

if (import.meta.main) {
  try {
    const parsed = parseContextContinuityArgs(process.argv.slice(2));
    if (parsed.action === "checkpoint") {
      console.log(JSON.stringify(issueContinuityCheckpoint(parsed.directory, parsed.model, parsed.window)));
    } else {
      const result = await verifyContinuityCheckpoint(
        parsed.directory,
        parsed.model,
        parsed.window,
        parsed.token,
      );
      console.log(JSON.stringify({
        recorded: result.recorded,
        duplicate: result.duplicate,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
      }));
    }
  } catch {
    console.error("Context continuity receipt was not recorded. Check the arguments and local state.");
    process.exitCode = 1;
  }
}
