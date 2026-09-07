import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { resolveCodexStateDbPath } from "./paths";

export const REPORT_MODELS = ["gpt-5.6-sol", "gpt-6-astra"] as const;
export const REPORT_REASONS = ["checkpoint_missing", "notes_error", "history_error", "goal_lost", "constraints_uncertain"] as const;
export const REPORT_STAGES = ["pre_reset", "post_reset"] as const;
export const REPORT_OUTCOMES = ["recovered", "unresolved"] as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ContextFailureInput {
  model: string;
  window: string;
  stage: string;
  reason: string;
  outcome: string;
}

export type ContextFailureClassification =
  | "checkpoint_not_created"
  | "backend_error"
  | "tool_argument_error";

export type ContextFailureEvidenceStatus = "observed" | "unverified";

export interface ContextFailureReportResult {
  recorded: boolean;
  duplicate: boolean;
  file: string;
  /** True when the bounded evidence guard intentionally emitted no report. */
  suppressed?: boolean;
  /** A bounded classification, never an inferred root cause or recovery verdict. */
  classification?: ContextFailureClassification;
  evidence_status?: ContextFailureEvidenceStatus;
}

interface RolloutEvidence {
  status: ContextFailureEvidenceStatus;
  complete: boolean;
  validRecords: number;
  nativeCheckpointWrites: number;
  ambiguousNotesCalls: number;
  backendErrors: number;
  invalidArguments: number;
  /** A native write is evidence that an attempt happened, not proof of persistence. */
  checkpointWriteObserved: boolean;
  /** Internal call correlation only; never persisted as report metadata. */
  nativeNotesCallIds: Set<string>;
}

interface ReportEvidenceFields {
  classification?: ContextFailureClassification;
  evidence_status?: ContextFailureEvidenceStatus;
  backend_error_observed?: boolean;
  tool_argument_error_observed?: boolean;
  checkpoint_write_observed?: boolean;
  recovery_evidence: "unverified";
}

const BACKEND_REQUEST_FAILURE = "Unable to perform operation: The backend request failed.";
const MAX_ROLLOUT_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_ROLLOUT_SCAN_MS = 2_000;
const RECENT_EVIDENCE_MS = 10 * 60 * 1000;
const ROLLOUT_CHUNK_BYTES = 64 * 1024;
const NOTES_WRITE_NAMES = new Set(["write_file", "append_to_file"]);
const NOTES_READ_NAMES = new Set(["read_file", "list_files_by_prefix"]);

/** Local, explicit model testimony; it is never promoted into an observed backend failure. */
export function writeContextFailureReport(
  directory: string, input: ContextFailureInput,
  env: NodeJS.ProcessEnv = process.env,
  extra: Partial<ReportEvidenceFields> = {},
): ContextFailureReportResult {
  if (!isAbsolute(directory)) throw new Error("An absolute report directory is required");
  if (!(REPORT_MODELS as readonly string[]).includes(input.model)
    || !(REPORT_REASONS as readonly string[]).includes(input.reason)
    || !(REPORT_STAGES as readonly string[]).includes(input.stage)
    || !(REPORT_OUTCOMES as readonly string[]).includes(input.outcome)
    || (input.window !== "unknown" && !UUID.test(input.window))) {
    throw new Error("Invalid context self-report fields");
  }
  const thread = UUID.test(env.CODEX_THREAD_ID ?? "") ? env.CODEX_THREAD_ID! : null;
  const window = input.window === "unknown" ? null : input.window;
  const simulation = env.OPENCODEX_CONTEXT_REPORT_TEST === "1";
  // Without a window id we cannot safely identify retries across different resets.
  const scope = window ?? randomUUID();
  const incident = createHash("sha256").update(JSON.stringify([
    scope, input.model, input.stage, input.reason, simulation,
  ])).digest("hex");
  const file = join(directory, `${incident}-${input.outcome}.json`);
  const baseReport = {
    version: 1,
    source: "model_self_report",
    independently_verified: false,
    simulation,
    recorded_at: new Date().toISOString(),
    incident_id: incident,
    model: input.model,
    thread_id: thread,
    context_window_id: window,
    stage: input.stage,
    reason: input.reason,
    outcome: input.outcome,
  };
  const report = { ...baseReport, ...extra };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    // One bounded metadata file per event. Exclusive creation makes retries idempotent and
    // concurrent reporters cannot overwrite each other; no shared journal rotation can lose data.
    writeFileSync(file, `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // A partial or corrupt earlier write must not be acknowledged as a saved report.
      try {
        if (statSync(file).size <= 4096) {
          const previous = JSON.parse(readFileSync(file, "utf8"));
          if (Object.entries(baseReport).every(([key, value]) => key === "recorded_at"
            ? typeof previous[key] === "string" && Number.isFinite(Date.parse(previous[key]))
            : previous[key] === value)) return { recorded: true, duplicate: true, file };
        }
      } catch { /* Report the same bounded failure as any other local write problem. */ }
    }
    throw new Error("Context self-report could not be saved locally");
  }
  return { recorded: true, duplicate: false, file };
}

/**
 * Resolve only the current thread's rollout through Codex's state database.
 * This is deliberately read-only and never searches the home directory.
 */
function resolveCurrentThreadRolloutPath(threadId: string, env: NodeJS.ProcessEnv): string | null {
  if (!UUID.test(threadId)) return null;
  let database: Database | undefined;
  try {
    const path = resolveCodexStateDbPath({
      codexHome: env.CODEX_HOME,
      env,
    });
    database = new Database(path, { readonly: true });
    const row = database.query<{ rollout_path: string }, [string]>(
      "SELECT rollout_path FROM threads WHERE id = ? LIMIT 1",
    ).get(threadId);
    if (!row || typeof row.rollout_path !== "string" || !isAbsolute(row.rollout_path)
      || row.rollout_path.includes("\u0000")) return null;
    return row.rollout_path;
  } catch {
    return null;
  } finally {
    try { database?.close(); } catch { /* read-only evidence is best effort */ }
  }
}

function parseRolloutRecord(line: string): { type?: unknown; timestamp?: unknown; payload?: unknown } | null {
  try {
    const record = JSON.parse(line) as unknown;
    return record && typeof record === "object" ? record as { type?: unknown; timestamp?: unknown; payload?: unknown } : null;
  } catch {
    return null;
  }
}

function payloadObject(record: { payload?: unknown }): Record<string, unknown> | null {
  return record.payload && typeof record.payload === "object"
    ? record.payload as Record<string, unknown> : null;
}

function isNotesNamespace(payload: Record<string, unknown>): boolean {
  return payload.namespace === "notes" || payload.name === "notes.write_file"
    || payload.name === "notes.append_to_file" || payload.name === "notes.list_files_by_prefix"
    || payload.name === "notes.read_file";
}

function callIdentifier(payload: Record<string, unknown>): string | null {
  const value = payload.call_id ?? payload.callId ?? payload.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasOpaqueEncryptedOutput(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.output)) return false;
  return payload.output.some(item => item && typeof item === "object"
    && Object.prototype.hasOwnProperty.call(item, "encrypted_content"));
}

function looksLikeAmbiguousDynamicNotesCall(payload: Record<string, unknown>): boolean {
  if (payload.type !== "custom_tool_call" && payload.type !== "function_call") return false;
  if (isNotesNamespace(payload)) return false;
  const name = typeof payload.name === "string" ? payload.name : "";
  const input = typeof payload.input === "string" ? payload.input : "";
  if (!name && !input) return false;
  // Generic shell/exec calls are normal and do not make the scan uncertain. Mark only
  // calls whose payload explicitly contains a dynamic Notes invocation or write operation.
  return /(?:tools\.[A-Za-z0-9_.-]*notes|mcp__[^\s"']*notes|namespace\s*[:=]\s*["']notes|notes(?:\/v2)?\/(?:write|append)|\bnotes\.(?:write_file|append_to_file)\b)/i.test(`${name}\n${input}`);
}

function invalidNotesArguments(payload: Record<string, unknown>): boolean {
  if (!isNotesNamespace(payload) || payload.type !== "function_call") return false;
  const name = typeof payload.name === "string" ? payload.name.replace(/^notes\./, "") : "";
  if (name !== "list_files_by_prefix") return false;
  const raw = typeof payload.arguments === "string" ? payload.arguments : "";
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return !!parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).prefix === "";
  } catch {
    return false;
  }
}

function backendFailureOutput(payload: Record<string, unknown>): boolean {
  if (payload.type !== "function_call_output") return false;
  // The native path emits a plain string. Do not infer from encrypted or structured output.
  return payload.output === BACKEND_REQUEST_FAILURE;
}

function emptyRolloutEvidence(status: ContextFailureEvidenceStatus = "unverified"): RolloutEvidence {
  return {
    status,
    complete: false,
    validRecords: 0,
    nativeCheckpointWrites: 0,
    ambiguousNotesCalls: 0,
    backendErrors: 0,
    invalidArguments: 0,
    checkpointWriteObserved: false,
    nativeNotesCallIds: new Set(),
  };
}

function considerRolloutLine(
  line: string,
  evidence: RolloutEvidence,
  input: ContextFailureInput,
  offset: number,
  now: number,
  windowAnchor: { offset: number; timestamp: number },
): void {
  if (!line) return;
  const record = parseRolloutRecord(line);
  if (!record) {
    // A malformed relevant line is enough to make absence unprovable. Ordinary unrelated
    // plaintext in a rollout is not expected, so fail open for any malformed JSONL record.
    evidence.complete = false;
    return;
  }
  evidence.validRecords += 1;
  const payload = payloadObject(record);
  if (!payload) return;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (input.window !== "unknown" && line.includes(input.window)) {
    windowAnchor.offset = offset;
    windowAnchor.timestamp = timestamp;
  }
  const type = payload.type;
  if ((type === "function_call" || type === "custom_tool_call") && isNotesNamespace(payload)) {
    const callId = callIdentifier(payload);
    if (callId) evidence.nativeNotesCallIds.add(callId);
    const name = typeof payload.name === "string" ? payload.name.replace(/^notes\./, "") : "";
    if (NOTES_WRITE_NAMES.has(name)) {
      evidence.nativeCheckpointWrites += 1;
      evidence.checkpointWriteObserved = true;
    } else if (!NOTES_READ_NAMES.has(name)) {
      evidence.ambiguousNotesCalls += 1;
    }
  } else if (looksLikeAmbiguousDynamicNotesCall(payload)) {
    evidence.ambiguousNotesCalls += 1;
  }

  // Encrypted native Notes output cannot establish whether a read succeeded or what it
  // contained. Correlate by call id so unrelated encrypted tool output does not invalidate a
  // complete no-write scan; an explicitly Notes-namespaced output without an id is ambiguous.
  if (type === "function_call_output" && hasOpaqueEncryptedOutput(payload)) {
    const callId = callIdentifier(payload);
    if (callId ? evidence.nativeNotesCallIds.has(callId) : isNotesNamespace(payload)) {
      evidence.ambiguousNotesCalls += 1;
    }
  }

  const recent = Number.isFinite(timestamp) && Math.abs(now - timestamp) <= RECENT_EVIDENCE_MS;
  const anchored = input.window !== "unknown"
    && Number.isFinite(windowAnchor.offset) && offset >= windowAnchor.offset
    && Number.isFinite(windowAnchor.timestamp)
    && Math.abs(now - windowAnchor.timestamp) <= RECENT_EVIDENCE_MS;
  const currentOrRecent = anchored || recent;
  if (invalidNotesArguments(payload) && currentOrRecent) evidence.invalidArguments += 1;
  if (backendFailureOutput(payload) && currentOrRecent) evidence.backendErrors += 1;
}

/**
 * Async bounded scanner used by the shell reporter. It never materializes a rollout in memory;
 * only one high-water-mark chunk and one incomplete line are retained.
 */
async function inspectRollout(path: string, input: ContextFailureInput): Promise<RolloutEvidence> {
  const evidence = emptyRolloutEvidence("unverified");
  const started = performance.now();
  const now = Date.now();
  const windowAnchor = { offset: Number.POSITIVE_INFINITY, timestamp: Number.NaN };
  let bytes = 0;
  let offset = 0;
  let carry = "";
  let bounded = false;
  evidence.complete = true;
  try {
    const stream = createReadStream(path, { highWaterMark: ROLLOUT_CHUNK_BYTES });
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + data.byteLength > MAX_ROLLOUT_SCAN_BYTES || performance.now() - started > MAX_ROLLOUT_SCAN_MS) {
        bounded = true;
        break;
      }
      bytes += data.byteLength;
      carry += data.toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        considerRolloutLine(line, evidence, input, offset, now, windowAnchor);
        offset += Buffer.byteLength(line) + 1;
      }
      if (performance.now() - started > MAX_ROLLOUT_SCAN_MS) {
        bounded = true;
        break;
      }
    }
    if (bounded) {
      evidence.complete = false;
    } else {
      if (carry) {
        considerRolloutLine(carry, evidence, input, offset, now, windowAnchor);
        offset += Buffer.byteLength(carry);
      }
    }
    evidence.status = evidence.complete && evidence.validRecords > 0 && evidence.ambiguousNotesCalls === 0
      ? "observed" : "unverified";
  } catch {
    evidence.status = "unverified";
    evidence.complete = false;
  }
  return evidence;
}

function reportEvidenceFor(input: ContextFailureInput, evidence: RolloutEvidence | null): ReportEvidenceFields {
  const fields: ReportEvidenceFields = { recovery_evidence: "unverified" };
  if (!evidence) return fields;
  fields.evidence_status = evidence.status;
  if (evidence.backendErrors > 0) {
    fields.classification = "backend_error";
    fields.backend_error_observed = true;
  }
  if (evidence.invalidArguments > 0) {
    if (!fields.classification) fields.classification = "tool_argument_error";
    fields.tool_argument_error_observed = true;
  }
  if (evidence.checkpointWriteObserved) {
    fields.checkpoint_write_observed = true;
  }
  if (!fields.classification && input.reason === "checkpoint_missing"
    && evidence.complete && evidence.validRecords > 0 && evidence.ambiguousNotesCalls === 0
    && evidence.nativeCheckpointWrites === 0) {
    fields.classification = "checkpoint_not_created";
  }
  return fields;
}

function shouldSuppressCheckpoint(input: ContextFailureInput, evidence: RolloutEvidence | null): boolean {
  return input.reason === "checkpoint_missing"
    && !!evidence
    && evidence.complete
    && evidence.status === "observed"
    && evidence.validRecords > 0
    && evidence.nativeCheckpointWrites === 0
    && evidence.ambiguousNotesCalls === 0
    && evidence.backendErrors === 0
    && evidence.invalidArguments === 0;
}

/**
 * Evidence-aware reporter used by the CLI. The historical sync writer remains available to
 * library callers, while this path performs the read-only current-thread guard before writing.
 */
export async function writeContextFailureReportWithEvidence(
  directory: string,
  input: ContextFailureInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContextFailureReportResult> {
  if (!isAbsolute(directory)) throw new Error("An absolute report directory is required");
  if (!(REPORT_MODELS as readonly string[]).includes(input.model)
    || !(REPORT_REASONS as readonly string[]).includes(input.reason)
    || !(REPORT_STAGES as readonly string[]).includes(input.stage)
    || !(REPORT_OUTCOMES as readonly string[]).includes(input.outcome)
    || (input.window !== "unknown" && !UUID.test(input.window))) {
    throw new Error("Invalid context self-report fields");
  }
  const simulation = env.OPENCODEX_CONTEXT_REPORT_TEST === "1";
  const thread = UUID.test(env.CODEX_THREAD_ID ?? "") ? env.CODEX_THREAD_ID! : null;
  let evidence: RolloutEvidence | null = null;
  if (!simulation) {
    evidence = emptyRolloutEvidence("unverified");
    if (thread) {
      const path = resolveCurrentThreadRolloutPath(thread, env);
      if (path) evidence = await inspectRollout(path, input);
    }
  }
  const evidenceFields = reportEvidenceFor(input, evidence);
  if (shouldSuppressCheckpoint(input, evidence)) {
    return {
      recorded: false,
      duplicate: false,
      file: "",
      suppressed: true,
      classification: "checkpoint_not_created",
      evidence_status: "observed",
    };
  }
  const result = writeContextFailureReport(directory, input, env, {
    ...evidenceFields,
    recovery_evidence: "unverified",
  });
  return {
    ...result,
    ...(evidenceFields.classification ? { classification: evidenceFields.classification } : {}),
    ...(evidenceFields.evidence_status ? { evidence_status: evidenceFields.evidence_status } : {}),
  };
}

function shellQuote(value: string): string {
  return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Repeated in native context guidance, so recovery failures do not depend on old chat text. */
export function contextFailureReportGuidance(model: string, directory: string): string {
  if (!(REPORT_MODELS as readonly string[]).includes(model)) throw new Error("Unsupported reporter model");
  const script = fileURLToPath(import.meta.url);
  const command = `${process.platform === "win32" ? "& " : ""}${shellQuote(process.execPath)} ${shellQuote(script)} --store ${shellQuote(directory)} --model ${model}`;
  return `After a context reset, recover the current goal, constraints, and next step before acting. A fresh window with no note is normal and is not an incident. A stale or incomplete checkpoint is separate from a checkpoint that was never created. For Notes listing, use valid arguments such as {} or prefix:null; an empty prefix (prefix:'') corrected without task impact is a tool_argument_error, not a backend or compaction failure. If a checkpoint is missing, a Notes/History operation fails, or the goal or constraints cannot be recovered, make a bounded recovery attempt, then run this reporter before warning the user:\n${command} --window <Current-context-window-id-or-unknown> --stage <${REPORT_STAGES.join("|")}> --reason <${REPORT_REASONS.join("|")}> --outcome <${REPORT_OUTCOMES.join("|")}>\nReplace angle-bracket placeholders with observed values. Use unknown only when no current window id is available. The reporter reads only the current thread's rollout through the local state database and stores redacted metadata, never note text, encrypted payloads, account data, or raw paths. It suppresses a checkpoint_missing report only when a complete bounded scan proves no native Notes write_file/append_to_file call and no ambiguous Notes-looking dynamic call; a normal fresh window or no note is not failure. Missing, unreadable, partial, encrypted, or ambiguous evidence remains unverified and must not be treated as success or as proof that storage failed. The exact plain output “${BACKEND_REQUEST_FAILURE}” is preserved as backend-error evidence only; it does not establish a root cause or status. A timed-out append may already have committed upstream: read back before retrying, and keep task recovery separate from checkpoint persistence. Never claim recovered independently; the outcome remains a model claim and unverified. If the reporter returns suppressed:true, do not show a context-failure warning. Otherwise, when you recognize a genuine recovery problem, include a bold Markdown status in the next user-facing reply and final answer: **컨텍스트 복구 문제 감지 — 복구 완료** only when the current MAIN task's recent user/assistant evidence supports that claim; otherwise **컨텍스트 복구 문제 감지 — 미해결** (translate only if the user requests another language). Briefly identify the observed problem and the evidence or what remains missing. If logging is unavailable or fails, also include **자기보고 기록 저장 실패**; do not escalate permissions or abandon useful work just for logging.`;
}

export function parseContextFailureArgs(args: string[]): { directory: string; input: ContextFailureInput } {
  const allowed = new Set(["store", "model", "window", "stage", "reason", "outcome"]);
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    const key = flag.startsWith("--") ? flag.slice(2) : "";
    const value = args[i + 1];
    if (!allowed.has(key) || fields[key] !== undefined || !value || value.startsWith("--")) {
      throw new Error("Expected --store, --model, --window, --stage, --reason and --outcome once each");
    }
    fields[key] = value;
  }
  if (Object.keys(fields).length !== allowed.size) throw new Error("Missing context self-report fields");
  return { directory: fields.store!, input: {
    model: fields.model!, window: fields.window!, stage: fields.stage!, reason: fields.reason!, outcome: fields.outcome!,
  } };
}

if (import.meta.main) {
  try {
    const { directory, input } = parseContextFailureArgs(process.argv.slice(2));
    const result = await writeContextFailureReportWithEvidence(directory, input);
    console.log(JSON.stringify({
      recorded: result.recorded,
      duplicate: result.duplicate,
      ...(result.suppressed === true ? { suppressed: true } : {}),
      ...(result.classification ? { classification: result.classification } : {}),
      ...(result.evidence_status ? { evidence_status: result.evidence_status } : {}),
      source: "model_self_report",
    }));
  } catch {
    console.error("Context self-report was not saved. Check the arguments and local write permission.");
    process.exitCode = 1;
  }
}
