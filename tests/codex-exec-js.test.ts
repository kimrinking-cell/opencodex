import { describe, expect, test } from "bun:test";
import {
  looksLikeCodexExecJs,
  parseExecCommandCli,
  repairCodexExecScript,
  wrapExecCommandAsJs,
} from "../src/lib/codex-exec-js";

const SESSION_CLI = String.raw`exec_command --cmd "cat \"/Users/kimrin/.codex/plugins/cache/openai-bundled/sites/0.1.37/skills/sites-building/SKILL.md\" 2>&1 | head -n 300" --workdir "/tmp/voice-mod"`;

const SESSION_JS = `const r1 = await tools.exec_command({cmd: "cat \\"/Users/kimrin/.codex/plugins/cache/openai-bundled/sites/0.1.37/skills/sites-building/SKILL.md\\" 2>&1 | head -n 250"});
text(r1.output);`;

describe("Codex exec JS contract repair", () => {
  test("parses the CLI shape Muse emitted in the looping session", () => {
    const parsed = parseExecCommandCli(SESSION_CLI);
    expect(parsed?.cmd).toContain("sites-building/SKILL.md");
    expect(parsed?.cmd).toContain("head -n 300");
    expect(parsed?.workdir).toBe("/tmp/voice-mod");
  });

  test("rewrites CLI-shaped exec input into tools.exec_command JavaScript", () => {
    const js = repairCodexExecScript("exec", SESSION_CLI);
    expect(js).toContain("await tools.exec_command(");
    expect(js).toContain("sites-building/SKILL.md");
    expect(js).toContain("/tmp/voice-mod");
    expect(js).not.toMatch(/^exec_command\s+--cmd/);
  });

  test("leaves real exec JavaScript unchanged", () => {
    expect(looksLikeCodexExecJs(SESSION_JS)).toBe(true);
    expect(repairCodexExecScript("exec", SESSION_JS)).toBe(SESSION_JS);
  });

  test("does not rewrite apply_patch or other freeform tools", () => {
    expect(repairCodexExecScript("apply_patch", SESSION_CLI)).toBe(SESSION_CLI);
  });

  test("does not rewrite Node import mistakes as shell", () => {
    const src = `// @exec: {"yield_time_ms": 20000}\nconst fs = await import("fs/promises");\n`;
    expect(repairCodexExecScript("exec", src)).toBe(src);
  });

  test("wraps cmd-only CLI without inventing a workdir", () => {
    const js = wrapExecCommandAsJs({ cmd: "ls -la" });
    expect(js).toBe("const r = await tools.exec_command({cmd: \"ls -la\"});\ntext(typeof r.output === \"string\" ? r.output : JSON.stringify(r));\n");
  });
});
