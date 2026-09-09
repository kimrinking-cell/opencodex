import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextFailureReportGuidance,
  parseContextFailureArgs,
  writeContextFailureReport,
  writeContextFailureReportWithEvidence,
  type ContextFailureInput,
} from "../../src/codex/context-failure-report";
import {
  contextContinuityReceiptGuidance,
  issueContinuityCheckpoint,
  parseContextContinuityArgs,
  verifyContinuityCheckpoint,
} from "../../src/codex/context-continuity-receipt";
let root: string;
let fixtureNumber = 0;
const input: ContextFailureInput = { model: "gpt-5.6-sol", window: "01a0717f-2ad9-7732-8a0d-054e5b0df245", stage: "post_reset", reason: "notes_error", outcome: "recovered" };
const THREAD_ID = "01a0717f-2ad9-7732-8a0d-054e5b0df246";
const DESTINATION_WINDOW = "01a0717f-2ad9-7732-8a0d-054e5b0df247";
const BACKEND_FAILURE = "Unable to perform operation: The backend request failed.";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-context-report-")); fixtureNumber = 0; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function rolloutLine(payload: Record<string, unknown>, timestamp = new Date().toISOString()): string {
  return JSON.stringify({ timestamp, type: "response_item", payload });
}

function makeStateFixture(lines: string[], rolloutPath?: string): NodeJS.ProcessEnv {
  const codexHome = join(root, `codex-home-${++fixtureNumber}`);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const path = rolloutPath ?? join(codexHome, "rollout.jsonl");
  if (rolloutPath !== "missing") writeFileSync(path, `${lines.join("\n")}\n`);
  const state = new Database(join(codexHome, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  state.query("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(THREAD_ID, path === "missing" ? join(codexHome, "missing.jsonl") : path);
  state.close();
  return { ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: THREAD_ID };
}

function currentSessionLines(...payloads: Record<string, unknown>[]): string[] {
  return [
    rolloutLine({ type: "session_meta", id: THREAD_ID }),
    rolloutLine({ type: "message", role: "user", context_window_id: input.window }),
    ...payloads.map(payload => rolloutLine(payload)),
  ];
}

const encryptedOutput = [{ type: "encrypted_content", encrypted_content: "fixture-encrypted-output" }];

function checkpointText(token: string): string {
  return `token: ${token}\ngoal: continue the real task\nuser_constraints: preserve user files\nverified_state: focused checks passed\nnext_action: run the next focused check\n`;
}

function appendTransition(
  env: NodeJS.ProcessEnv,
  token: string,
  options: {
    writePath?: string;
    writeText?: string;
    readback?: boolean;
    recovery?: "note" | "history" | "list" | "none";
    recoveryOutputAfterTask?: boolean;
    taskOutput?: unknown;
  } = {},
): void {
  const path = join(env.CODEX_HOME!, "rollout.jsonl");
  const writePath = options.writePath ?? "continuity/current.md";
  const writeText = options.writeText ?? checkpointText(token);
  const lines = [
    rolloutLine({ type: "function_call", namespace: "notes", name: "write_file", arguments: JSON.stringify({ path: writePath, text: writeText }), call_id: "checkpoint-write" }),
    rolloutLine({ type: "function_call_output", call_id: "checkpoint-write", output: encryptedOutput }),
  ];
  if (options.readback !== false) {
    lines.push(
      rolloutLine({ type: "function_call", namespace: "notes", name: "read_file", arguments: JSON.stringify({ path: "continuity/current.md" }), call_id: "checkpoint-readback" }),
      rolloutLine({ type: "function_call_output", call_id: "checkpoint-readback", output: encryptedOutput }),
    );
  }
  lines.push(JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "compacted",
    payload: { window_id: DESTINATION_WINDOW, previous_window_id: input.window, first_window_id: input.window },
  }));
  const recovery = options.recovery ?? "note";
  let deferredRecoveryOutput: string | undefined;
  if (recovery !== "none") {
    const payload = recovery === "note"
      ? { type: "function_call", namespace: "notes", name: "read_file", arguments: JSON.stringify({ path: "continuity/current.md" }), call_id: "recovery-read" }
      : recovery === "history"
        ? { type: "function_call", namespace: "history", name: "search_contents", arguments: JSON.stringify({ query: "continuity/current.md", window_id: input.window }), call_id: "recovery-read" }
        : { type: "function_call", namespace: "notes", name: "list_files_by_prefix", arguments: "{}", call_id: "recovery-read" };
    lines.push(rolloutLine(payload));
    const output = rolloutLine({ type: "function_call_output", call_id: "recovery-read", output: encryptedOutput });
    if (options.recoveryOutputAfterTask) deferredRecoveryOutput = output;
    else lines.push(output);
  }
  lines.push(
    rolloutLine({ type: "custom_tool_call", name: "functions.exec", input: "run one real task check", call_id: "task-action" }),
    rolloutLine({ type: "custom_tool_call_output", call_id: "task-action", output: options.taskOutput ?? "Script completed" }),
  );
  if (deferredRecoveryOutput) lines.push(deferredRecoveryOutput);
  appendFileSync(path, `${lines.join("\n")}\n`);
}

test("reports bounded metadata and deduplicates retries without erasing later recovery", () => {
  const dir = join(root, "reports");
  const first = writeContextFailureReport(dir, { ...input, outcome: "unresolved" }, {});
  expect(writeContextFailureReport(dir, { ...input, outcome: "unresolved" }, {}).duplicate).toBe(true);
  const recovered = writeContextFailureReport(dir, input, {});
  const report = JSON.parse(readFileSync(recovered.file, "utf8"));
  expect(report).toMatchObject({ source: "model_self_report", independently_verified: false, simulation: false, thread_id: null, outcome: "recovered" });
  expect(report.incident_id).toBe(JSON.parse(readFileSync(first.file, "utf8")).incident_id);
  expect(readdirSync(dir)).toHaveLength(2);
  expect(statSync(recovered.file).size).toBeLessThan(1024);
  if (process.platform !== "win32") {
    expect(statSync(recovered.file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }
});

test("simulation reports remain distinct and missing window ids do not hide later incidents", () => {
  const normal = writeContextFailureReport(root, input, {});
  const simulation = writeContextFailureReport(root, input, { OPENCODEX_CONTEXT_REPORT_TEST: "1" });
  expect(normal.file).not.toBe(simulation.file);
  expect(JSON.parse(readFileSync(simulation.file, "utf8")).simulation).toBe(true);
  const one = writeContextFailureReport(root, { ...input, window: "unknown" }, {});
  expect(writeContextFailureReport(root, { ...input, window: "unknown" }, {}).file).not.toBe(one.file);
});

test("corrupt existing reports and unwritable destinations never acknowledge success", () => {
  const result = writeContextFailureReport(root, input, {});
  writeFileSync(result.file, "{");
  expect(() => writeContextFailureReport(root, input, {})).toThrow("could not be saved");
  const blocked = join(root, "blocked"); writeFileSync(blocked, "file");
  expect(() => writeContextFailureReport(blocked, input, {})).toThrow();
});

test("arbitrary model names, text and malformed arguments cannot enter incident metadata", () => {
  for (const change of [{ model: "gpt-5.6-terra" }, { model: "gpt-5.6-luna" }, { reason: "private note contents" }, { window: "private thread text" }]) {
    expect(() => writeContextFailureReport(root, { ...input, ...change }, {})).toThrow("Invalid");
  }
  expect(readdirSync(root)).toHaveLength(0);
  expect(() => parseContextFailureArgs(["--store", root, "--store", root])).toThrow();
});

test("the actual shell reporter records an Astra incident and fails clearly on invalid input", () => {
  const script = join(import.meta.dir, "../../src/codex/context-failure-report.ts");
  const args = ["--store", root, "--model", "gpt-6-astra", "--window", input.window, "--stage", input.stage, "--reason", input.reason, "--outcome", input.outcome];
  const result = Bun.spawnSync([process.execPath, script, ...args], { env: { ...process.env, OPENCODEX_CONTEXT_REPORT_TEST: "1" } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ recorded: true, duplicate: false, source: "model_self_report" });
  expect(JSON.parse(readFileSync(join(root, readdirSync(root)[0]!), "utf8"))).toMatchObject({ model: "gpt-6-astra", simulation: true });
  const invalid = Bun.spawnSync([process.execPath, script, ...args, "--unexpected", "sensitive-fixture"]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr.toString()).toContain("not saved");
  expect(invalid.stderr.toString()).not.toContain("sensitive-fixture");
});

test("suppresses checkpoint_missing only when the complete current rollout proves no Notes write", async () => {
  const env = makeStateFixture(currentSessionLines(
    { type: "function_call", namespace: "notes", name: "list_files_by_prefix", arguments: "{}", call_id: "read-1" },
    { type: "function_call_output", call_id: "read-1", output: "[]" },
  ));
  const result = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, env);
  expect(result).toMatchObject({ recorded: false, suppressed: true, classification: "checkpoint_not_created", evidence_status: "observed" });
  expect(readdirSync(root)).toContain("codex-home-1");
  expect(readdirSync(join(root, "codex-home-1"))).not.toContain("reports");
  const script = join(import.meta.dir, "../../src/codex/context-failure-report.ts");
  const cli = Bun.spawnSync([process.execPath, script, "--store", root, "--model", input.model, "--window", input.window, "--stage", input.stage, "--reason", "checkpoint_missing", "--outcome", input.outcome], { env });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout.toString())).toMatchObject({ recorded: false, suppressed: true, classification: "checkpoint_not_created" });
});

test("keeps a native Notes write and the exact backend failure as a recorded report", async () => {
  const env = makeStateFixture(currentSessionLines(
    { type: "function_call", namespace: "notes", name: "append_to_file", arguments: "{\"path\":\"goal.md\"}", call_id: "write-1" },
    { type: "function_call_output", call_id: "write-1", output: BACKEND_FAILURE },
  ));
  const result = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, env);
  expect(result).toMatchObject({ recorded: true, classification: "backend_error", evidence_status: "observed" });
  const report = JSON.parse(readFileSync(result.file, "utf8"));
  expect(report).toMatchObject({ backend_error_observed: true, checkpoint_write_observed: true, recovery_evidence: "unverified" });
});

test("does not suppress when rollout evidence is missing, partial, encrypted, or dynamically ambiguous", async () => {
  const missing = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, makeStateFixture([], "missing"));
  expect(missing).toMatchObject({ recorded: true, evidence_status: "unverified" });

  const empty = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, makeStateFixture([]));
  expect(empty).toMatchObject({ recorded: true, evidence_status: "unverified" });

  const partial = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, makeStateFixture([
    ...currentSessionLines({ type: "function_call", namespace: "notes", name: "list_files_by_prefix", arguments: "{}", call_id: "read-partial" }),
    "{\"type\":\"response_item\"",
  ]));
  expect(partial).toMatchObject({ recorded: true, evidence_status: "unverified" });

  const encrypted = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, makeStateFixture(currentSessionLines(
    { type: "function_call", namespace: "notes", name: "read_file", call_id: "read-opaque" },
    { type: "function_call_output", call_id: "read-opaque", output: [{ type: "encrypted_content", encrypted_content: "opaque" }] },
  )));
  expect(encrypted).toMatchObject({ recorded: true, evidence_status: "unverified" });

  const ambiguous = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, makeStateFixture(currentSessionLines(
    { type: "custom_tool_call", name: "dynamic", input: "tools.notes.append_to_file({})" },
  )));
  expect(ambiguous).toMatchObject({ recorded: true, evidence_status: "unverified" });
  expect(readdirSync(root).some(name => name.endsWith(".json"))).toBe(true);
});

test("does not classify a native write as a never-created checkpoint", async () => {
  const env = makeStateFixture(currentSessionLines(
    { type: "function_call", namespace: "notes", name: "append_to_file", arguments: "{}", call_id: "write-only" },
    { type: "function_call_output", call_id: "write-only", output: "ok" },
  ));
  const result = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, env);
  expect(result).toMatchObject({ recorded: true, evidence_status: "observed" });
  expect(result.classification).toBeUndefined();
  expect(JSON.parse(readFileSync(result.file, "utf8"))).toMatchObject({ checkpoint_write_observed: true });
});

test("limits invalid argument evidence to the current or recent window", async () => {
  const oldInvalid = rolloutLine({
    type: "function_call", namespace: "notes", name: "list_files_by_prefix",
    arguments: "{\"prefix\":\"\"}", call_id: "bad-old",
  }, "2020-01-01T00:00:00.000Z");
  const env = makeStateFixture([oldInvalid, ...currentSessionLines(
    { type: "function_call", namespace: "notes", name: "list_files_by_prefix", arguments: "{}", call_id: "read-current" },
  )]);
  const result = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, env);
  expect(result).toMatchObject({ recorded: false, suppressed: true, classification: "checkpoint_not_created", evidence_status: "observed" });
});

test("classifies corrected invalid Notes arguments separately without suppressing a checkpoint report", async () => {
  const env = makeStateFixture(currentSessionLines(
    { type: "function_call", namespace: "notes", name: "list_files_by_prefix", arguments: "{\"prefix\":\"\"}", call_id: "bad-1" },
    { type: "function_call_output", call_id: "bad-1", output: "invalid prefix" },
    { type: "function_call", namespace: "notes", name: "list_files_by_prefix", arguments: "{\"prefix\":null}", call_id: "ok-1" },
    { type: "function_call_output", call_id: "ok-1", output: "[]" },
  ));
  const result = await writeContextFailureReportWithEvidence(root, { ...input, reason: "checkpoint_missing" }, env);
  expect(result).toMatchObject({ recorded: true, classification: "tool_argument_error", evidence_status: "observed" });
  expect(JSON.parse(readFileSync(result.file, "utf8"))).toMatchObject({ tool_argument_error_observed: true, recovery_evidence: "unverified" });
});

test("guidance keeps recovery and persistence claims unverified and preserves legacy CLI flags", () => {
  const guidance = contextFailureReportGuidance("gpt-5.6-sol", root);
  expect(guidance).toContain("prefix:null");
  expect(guidance).toContain("timed-out append may already have committed upstream");
  expect(guidance).toContain("Never claim recovered independently");
  expect(guidance).toContain("encrypted payloads");
  expect(parseContextFailureArgs(["--store", root, "--model", "gpt-5.6-sol", "--window", "unknown", "--stage", "post_reset", "--reason", "checkpoint_missing", "--outcome", "recovered"]).input.window).toBe("unknown");
});

test("records a private continuity receipt only after an exact checkpoint round trip and real continuation", async () => {
  const env = makeStateFixture(currentSessionLines());
  const directory = join(root, "continuity-success");
  const checkpoint = issueContinuityCheckpoint(directory, input.model, input.window, env);
  expect(checkpoint.issued).toBe(true);
  expect(checkpoint.token).toMatch(/^[a-f0-9]{32}$/);
  const stateFile = join(directory, "state", readdirSync(join(directory, "state"))[0]!);
  expect(readFileSync(stateFile, "utf8")).not.toContain(checkpoint.token);
  appendTransition(env, checkpoint.token);

  const result = await verifyContinuityCheckpoint(directory, input.model, DESTINATION_WINDOW, checkpoint.token, env);
  expect(result).toMatchObject({ recorded: true, duplicate: false, status: "verified" });
  const receipt = JSON.parse(readFileSync(result.file!, "utf8"));
  expect(receipt).toMatchObject({
    source: "local_context_continuity_guard",
    independently_verified: true,
    semantic_task_recovery: "unverified",
    checkpoint_write_observed: true,
    checkpoint_readback_observed: true,
    recovery_read_observed: true,
    task_action_observed: true,
    outcome: "healthy",
  });
  expect(readFileSync(result.file!, "utf8")).not.toContain(checkpoint.token);
  expect(await verifyContinuityCheckpoint(directory, input.model, DESTINATION_WINDOW, checkpoint.token, env))
    .toMatchObject({ recorded: true, duplicate: true, status: "verified" });
  const script = join(import.meta.dir, "../../src/codex/context-continuity-receipt.ts");
  const cli = Bun.spawnSync([
    process.execPath, script, "verify", "--store", directory, "--model", input.model,
    "--window", DESTINATION_WINDOW, "--token", checkpoint.token,
  ], { env });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout.toString())).toEqual({ recorded: true, duplicate: true, status: "verified" });
  expect(cli.stdout.toString()).not.toContain(directory);
  expect(cli.stdout.toString()).not.toContain(checkpoint.token);
  if (process.platform !== "win32") {
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(result.file!).mode & 0o777).toBe(0o600);
  }
});

test("accepts a targeted History fallback but not a generic post-reset listing", async () => {
  const historyEnv = makeStateFixture(currentSessionLines());
  const historyDirectory = join(root, "continuity-history");
  const historyCheckpoint = issueContinuityCheckpoint(historyDirectory, input.model, input.window, historyEnv);
  appendTransition(historyEnv, historyCheckpoint.token, { recovery: "history" });
  expect(await verifyContinuityCheckpoint(historyDirectory, input.model, DESTINATION_WINDOW, historyCheckpoint.token, historyEnv))
    .toMatchObject({ recorded: true, status: "verified" });

  const listEnv = makeStateFixture(currentSessionLines());
  const listDirectory = join(root, "continuity-list");
  const listCheckpoint = issueContinuityCheckpoint(listDirectory, input.model, input.window, listEnv);
  appendTransition(listEnv, listCheckpoint.token, { recovery: "list" });
  expect(await verifyContinuityCheckpoint(listDirectory, input.model, DESTINATION_WINDOW, listCheckpoint.token, listEnv))
    .toEqual({ recorded: false, duplicate: false, status: "inconclusive", reason: "recovery_read_unverified" });
});

test("rejects unrelated or incomplete checkpoint evidence instead of producing false success", async () => {
  const cases: Array<{
    name: string;
    options: Parameters<typeof appendTransition>[2];
    reason: string;
  }> = [
    { name: "wrong path", options: { writePath: "continuity/other.md" }, reason: "checkpoint_write_unverified" },
    { name: "missing token", options: { writeText: checkpointText("0".repeat(32)) }, reason: "checkpoint_write_unverified" },
    { name: "missing field", options: { writeText: "token: TOKEN\ngoal: fixture\nuser_constraints: fixture\nverified_state: fixture\n" }, reason: "checkpoint_write_unverified" },
    { name: "no readback", options: { readback: false }, reason: "checkpoint_readback_unverified" },
    { name: "no recovery", options: { recovery: "none" }, reason: "recovery_read_unverified" },
    { name: "task before recovery", options: { recoveryOutputAfterTask: true }, reason: "task_continuation_unverified" },
    { name: "failed task tool", options: { taskOutput: BACKEND_FAILURE }, reason: "task_continuation_unverified" },
  ];
  for (const [index, item] of cases.entries()) {
    const env = makeStateFixture(currentSessionLines());
    const directory = join(root, `continuity-negative-${index}`);
    const checkpoint = issueContinuityCheckpoint(directory, input.model, input.window, env);
    const options = item.name === "missing field"
      ? { ...item.options, writeText: (item.options.writeText as string).replace("TOKEN", checkpoint.token) }
      : item.options;
    appendTransition(env, checkpoint.token, options);
    expect(await verifyContinuityCheckpoint(directory, input.model, DESTINATION_WINDOW, checkpoint.token, env), item.name)
      .toEqual({ recorded: false, duplicate: false, status: "inconclusive", reason: item.reason });
    expect(readdirSync(directory)).not.toContain("receipts");
  }
});

test("rejects same-window, wrong-token, and malformed CLI verification without leaking arguments", async () => {
  const env = makeStateFixture(currentSessionLines());
  const directory = join(root, "continuity-identity");
  const checkpoint = issueContinuityCheckpoint(directory, input.model, input.window, env);
  expect(await verifyContinuityCheckpoint(directory, input.model, input.window, checkpoint.token, env))
    .toMatchObject({ status: "inconclusive", reason: "same_window" });
  expect(await verifyContinuityCheckpoint(directory, input.model, DESTINATION_WINDOW, "0".repeat(32), env))
    .toMatchObject({ status: "inconclusive", reason: "token_mismatch" });
  expect(() => parseContextContinuityArgs(["verify", "--store", directory, "--token", "sensitive-fixture"]))
    .toThrow("Missing context continuity arguments");
  const guidance = contextContinuityReceiptGuidance(input.model, directory);
  expect(guidance).toContain("during real work, never synthetic test work");
  expect(guidance).toContain("token: <Returned-token>");
  expect(guidance).toContain("semantic task correctness");
  expect(guidance).toContain("An inconclusive result is not a failure");
});
