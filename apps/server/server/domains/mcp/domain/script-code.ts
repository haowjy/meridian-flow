import { stripTypeScriptTypes } from "node:module";

export type PreparedCode =
  | { ok: true; code: string }
  | { ok: false; error: { name: string; message: string; line?: number } };

const FENCE = /^\s*```[A-Za-z]*[ \t]*\n([\s\S]*?)\n?```\s*$/;

const OPEN = "async function f(){";
const CLOSE = "\n}";

export function prepareScript(source: string): PreparedCode {
  const fenced = FENCE.exec(source);
  const code = fenced ? `\n${fenced[1]}` : source;
  try {
    // keep: Wrap model scripts and strip types in place so top-level return parses and offsets stay fixed
    const stripped = stripTypeScriptTypes(`${OPEN}${code}${CLOSE}`, { mode: "strip" });
    return { ok: true, code: stripped.slice(OPEN.length, stripped.length - CLOSE.length) };
  } catch (cause) {
    const error = cause as Error & { code?: string; stack?: string };
    const line = /^:(\d+)\n/.exec(error.stack ?? "")?.[1];
    return {
      ok: false,
      error: {
        name: "SyntaxError",
        message: error.message,
        ...(line ? { line: Math.min(Number(line), code.split("\n").length) } : {}),
      },
    };
  }
}
