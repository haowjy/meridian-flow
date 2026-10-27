/**
 * Worker-thread entry: runs RE2 over text on behalf of `match-pool.ts`.
 *
 * Matching happens here, not on the server's event loop, because a single `re2js` call over a long
 * line cannot be interrupted and no static pattern limit separates cheap patterns from slow ones.
 * The pool terminates this thread when a request outlives its deadline. It handles one request at
 * a time; the pattern travels with each request and the compiled form is cached by it.
 *
 * Imports only `re2js`, so the file runs unbundled and as its own bundle entry.
 */
import { parentPort } from "node:worker_threads";
import { RE2JS } from "re2js";

type Span = [start: number, end: number];
/** A block's index among the texts sent, and its first match as offsets into that text. */
export type Passage = [index: number, start: number, end: number];

export type MatchRequest = { pattern: string; ignoreCase: boolean } & (
  | { op: "count"; text: string; all: boolean }
  | { op: "passages"; texts: readonly string[]; limit: number }
);

/** What each op replies with. */
export interface MatchValue {
  count: number;
  passages: Passage[];
}

export type MatchReply<Op extends keyof MatchValue = keyof MatchValue> =
  | { ok: true; value: MatchValue[Op] }
  | { ok: false; error: string };

const CACHE_SIZE = 8;
const compiled = new Map<string, RE2JS>();

function compile({ pattern, ignoreCase }: MatchRequest): RE2JS {
  const key = `${ignoreCase ? "i" : "-"}${pattern}`;
  let program = compiled.get(key);
  if (!program) {
    program = RE2JS.compile(pattern, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
    if (compiled.size >= CACHE_SIZE) compiled.delete(compiled.keys().next().value as string);
    compiled.set(key, program);
  }
  return program;
}

function firstSpan(program: RE2JS, text: string): Span | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    const matcher = program.matcher(line);
    if (matcher.find()) return [offset + matcher.start(), offset + matcher.end()];
    offset += line.length + 1;
  }
  return null;
}

function countAll(program: RE2JS, text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    const matcher = program.matcher(line);
    while (matcher.find()) count += 1;
  }
  return count;
}

function run(request: MatchRequest): MatchValue[keyof MatchValue] {
  const program = compile(request);
  switch (request.op) {
    case "count":
      return request.all
        ? countAll(program, request.text)
        : Number(firstSpan(program, request.text) !== null);
    case "passages": {
      const passages: Passage[] = [];
      for (const [index, text] of request.texts.entries()) {
        if (passages.length === request.limit) break;
        const span = firstSpan(program, text);
        if (span) passages.push([index, span[0], span[1]]);
      }
      return passages;
    }
  }
}

parentPort?.on("message", (request: MatchRequest) => {
  let reply: MatchReply;
  try {
    reply = { ok: true, value: run(request) };
  } catch (cause) {
    reply = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  parentPort?.postMessage(reply);
});
