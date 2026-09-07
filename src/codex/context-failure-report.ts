import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Local, explicit model testimony; it is never promoted into an observed backend failure. */
export function writeContextFailureReport(
  directory: string, input: ContextFailureInput,
  env: NodeJS.ProcessEnv = process.env,
): { recorded: boolean; duplicate: boolean; file: string } {
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
  const report = {
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
          if (Object.entries(report).every(([key, value]) => key === "recorded_at"
            ? typeof previous[key] === "string" && Number.isFinite(Date.parse(previous[key]))
            : previous[key] === value)) return { recorded: true, duplicate: true, file };
        }
      } catch { /* Report the same bounded failure as any other local write problem. */ }
    }
    throw new Error("Context self-report could not be saved locally");
  }
  return { recorded: true, duplicate: false, file };
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
  return `After a context reset, recover the current goal, constraints, and next step before acting. If a checkpoint is missing, a Notes/History operation fails, or the goal or constraints cannot be recovered, make a bounded recovery attempt. When you detect such a problem, self-report it once even if you later recover. Use the local shell tool to run:\n${command} --window <Current-context-window-id-or-unknown> --stage <${REPORT_STAGES.join("|")}> --reason <${REPORT_REASONS.join("|")}> --outcome <${REPORT_OUTCOMES.join("|")}>\nReplace angle-bracket placeholders with the observed values. Use unknown only when no current window id is available. This records local metadata only, not user text or note contents. It is your self-report, not independent verification. Do not invent failures, report normal resets as failures, or claim recovery without evidence. Whenever you recognize a recovery problem, include a bold Markdown status in your next user-facing reply and in the final answer: **컨텍스트 복구 문제 감지 — 복구 완료** if recovered, or **컨텍스트 복구 문제 감지 — 미해결** otherwise (translate only if the user requests another language). Briefly identify the observed problem and recovery evidence or what is missing. If logging is unavailable or fails, also include **자기보고 기록 저장 실패**; do not escalate permissions or abandon useful work just for logging. If recovery remains incomplete, state what is missing rather than silently treating this as a new task.`;
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
    const result = writeContextFailureReport(directory, input);
    console.log(JSON.stringify({ recorded: result.recorded, duplicate: result.duplicate, source: "model_self_report" }));
  } catch {
    console.error("Context self-report was not saved. Check the arguments and local write permission.");
    process.exitCode = 1;
  }
}
