import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContextFailureArgs, writeContextFailureReport, type ContextFailureInput } from "../../src/codex/context-failure-report";
let root: string;
const input: ContextFailureInput = { model: "gpt-5.6-sol", window: "01a0717f-2ad9-7732-8a0d-054e5b0df245", stage: "post_reset", reason: "notes_error", outcome: "recovered" };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-context-report-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

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
