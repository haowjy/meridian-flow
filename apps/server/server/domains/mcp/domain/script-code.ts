/**
 * What a model's `mcp_run` code becomes before the runner sees it: code fences off, types
 * stripped, line numbers unchanged (an error's line points into the code the model wrote).
 */
import { stripTypeScriptTypes } from "node:module";

export type PreparedCode =
  | { ok: true; code: string }
  | { ok: false; error: { name: string; message: string; line?: number } };

/** A model often wraps code in a fence; the fence's lines become empty lines so the rest keeps its numbers. */
const FENCE = /^\s*```[A-Za-z]*[ \t]*\n([\s\S]*?)\n?```\s*$/;

const OPEN = "async function f(){";
const CLOSE = "\n}";

export function prepareScript(source: string): PreparedCode {
  const fenced = FENCE.exec(source);
  const code = fenced ? `\n${fenced[1]}` : source;
  try {
    // The stripper refuses a bare function body (`return` outside a function), so the code goes
    // in a wrapper on its first line and comes out of it again; stripping replaces types with
    // spaces, so nothing shifts.
    const stripped = stripTypeScriptTypes(`${OPEN}${code}${CLOSE}`, { mode: "strip" });
    return { ok: true, code: stripped.slice(OPEN.length, stripped.length - CLOSE.length) };
  } catch (cause) {
    const error = cause as Error & { code?: string; stack?: string };
    // The stripper's stack opens with `:<line>` of the wrapped code, whose first line is the code's first;
    // an error at the end of the input points at the wrapper's closing line, past the code.
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
