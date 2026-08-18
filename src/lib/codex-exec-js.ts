/**
 * Codex Desktop 0.148+ exposes a freeform `exec` tool whose body is a JavaScript
 * program (`tools.exec_command`, `tools.mcp__…`, `text()`). Routed models often
 * treat it as a CLI (`exec_command --cmd …`) or as Node (`import("fs")`).
 * Shared contract + a conservative repair for the CLI shape.
 */

export const CODEX_EXEC_TOOL_NAME = "exec";

export const CODEX_EXEC_JS_CONTRACT =
  "The `exec` tool input is a JavaScript program, not a shell line and not a CLI. "
  + "Call it as {\"input\":\"<js>\"}. Inside that program run shell with "
  + "`const r = await tools.exec_command({cmd: \"ls\", workdir?: \"/abs\"}); text(r.output);` "
  + "and MCP with `const x = await tools.mcp__<server>__<tool>({...})`. "
  + "Do not write `exec_command --cmd`. Do not import() Node modules. "
  + "Do not treat `exec_command` as a process name.";

export function isCodexExecToolName(name: string | undefined): boolean {
  return name === CODEX_EXEC_TOOL_NAME;
}

/** True when the body already looks like Codex exec JavaScript. */
export function looksLikeCodexExecJs(source: string): boolean {
  return /\btools\.(?:exec_command|mcp__)/.test(source)
    || /\bawait\s+tools\./.test(source)
    || /\/\/\s*@exec\b/.test(source);
}

function unquote(token: string): string {
  if (token.length >= 2) {
    const start = token[0];
    const end = token[token.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      const inner = token.slice(1, -1);
      return start === '"'
        ? inner.replace(/\\([\\nrt"])/g, (_, ch: string) => {
          if (ch === "n") return "\n";
          if (ch === "t") return "\t";
          if (ch === "r") return "\r";
          return ch;
        })
        : inner.replace(/\\'/g, "'");
    }
  }
  return token;
}

function tokenizeExecCli(source: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (i >= source.length) break;
    const quote = source[i] === '"' || source[i] === "'" ? source[i] : undefined;
    if (quote) {
      let out = quote;
      i++;
      while (i < source.length) {
        const ch = source[i]!;
        out += ch;
        i++;
        if (ch === "\\" && i < source.length) {
          out += source[i];
          i++;
          continue;
        }
        if (ch === quote) break;
      }
      tokens.push(out);
      continue;
    }
    let start = i;
    while (i < source.length && !/\s/.test(source[i]!)) i++;
    tokens.push(source.slice(start, i));
  }
  return tokens.length > 0 ? tokens : null;
}

export function parseExecCommandCli(source: string): { cmd: string; workdir?: string } | null {
  const trimmed = source.trim();
  if (!/^exec_command\s+--/.test(trimmed)) return null;
  if (looksLikeCodexExecJs(trimmed)) return null;
  const tokens = tokenizeExecCli(trimmed);
  if (!tokens || tokens[0] !== "exec_command") return null;
  let cmd: string | undefined;
  let workdir: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i];
    const value = tokens[i + 1];
    if (flag === "--cmd" && value) {
      cmd = unquote(value);
      i++;
      continue;
    }
    if (flag === "--workdir" && value) {
      workdir = unquote(value);
      i++;
    }
  }
  return cmd ? { cmd, ...(workdir ? { workdir } : {}) } : null;
}

export function wrapExecCommandAsJs(call: { cmd: string; workdir?: string }): string {
  const args = call.workdir
    ? `{cmd: ${JSON.stringify(call.cmd)}, workdir: ${JSON.stringify(call.workdir)}}`
    : `{cmd: ${JSON.stringify(call.cmd)}}`;
  return `const r = await tools.exec_command(${args});\ntext(typeof r.output === "string" ? r.output : JSON.stringify(r));\n`;
}

/**
 * If a routed model stuffed a CLI-shaped `exec_command --cmd` into Codex `exec`,
 * rewrite it to the JS the Desktop runtime actually evaluates. Leave real JS alone.
 */
export function repairCodexExecScript(toolName: string | undefined, source: string): string {
  if (!isCodexExecToolName(toolName) || looksLikeCodexExecJs(source)) return source;
  const parsed = parseExecCommandCli(source);
  return parsed ? wrapExecCommandAsJs(parsed) : source;
}
