/** One tool call as history writes it (D48): exact lines from fixed typed inputs. */
import { describe, expect, it } from "vitest";
import { CALL_LINE_CAP, callLine, orderLikeSchema, shortenCallArgs } from "./history-call-line.js";

const words = (count: number, word = "word") => Array.from({ length: count }, () => word).join(" ");

describe("shortenCallArgs", () => {
  it("leaves a string up to 60 characters whole", () => {
    const sixty = "x".repeat(60);
    expect(shortenCallArgs("read", { path: sixty })).toEqual({ path: sixty });
    expect(shortenCallArgs("read", { path: `${sixty}y` })).toEqual({
      path: `${"x".repeat(40)}…(61 chars)`,
    });
  });

  it("shortens nested strings in objects and arrays", () => {
    expect(
      shortenCallArgs("spawn", {
        agent: "critic",
        files: [{ path: "a.md", note: words(30, "note") }],
        options: { prompt: words(50, "go") },
      }),
    ).toEqual({
      agent: "critic",
      files: [{ path: "a.md", note: "note note note note note note note note…(30 words)" }],
      options: { prompt: "go go go go go go go go go go go go go…(50 words)" },
    });
  });

  it("shortens further rather than dropping keys when a call is over the line cap", () => {
    const args = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`field${i}`, words(40, "long")]),
    );
    const shortened = shortenCallArgs("work", args);
    expect(Object.keys(shortened)).toEqual(Object.keys(args));
    expect(`work(${JSON.stringify(shortened)})`.length).toBeLessThanOrEqual(CALL_LINE_CAP);
    expect(shortened.field0).toBe("…(40 words)");
  });

  it("keeps a 16-character prefix when that is enough to fit the cap", () => {
    const args = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`f${i}`, words(40, "long")]),
    );
    expect(shortenCallArgs("work", args).f0).toBe("long long long…(40 words)");
  });
});

describe("callLine", () => {
  it("writes failures with their status or code, and running and cancelled calls", () => {
    const args = { path: "skill://story-review/resources/developmental-edit.md" };
    expect(callLine({ tool: "read", args, state: "error", summary: "document_not_found" })).toBe(
      'read({"path":"skill://story-review/resources/developmental-edit.md"}) → failed: document_not_found',
    );
    expect(callLine({ tool: "read", args, state: "error" })).toBe(
      'read({"path":"skill://story-review/resources/developmental-edit.md"}) → failed',
    );
    expect(callLine({ tool: "spawn", args: { agent: "critic" }, state: "running" })).toBe(
      'spawn({"agent":"critic"}) → running',
    );
    expect(callLine({ tool: "spawn", args: { agent: "critic" }, state: "cancelled" })).toBe(
      'spawn({"agent":"critic"}) → cancelled',
    );
  });
});

describe("orderLikeSchema", () => {
  const write = {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          command: { type: "string", const: "create" },
          path: { type: "string" },
          content: { type: "string" },
        },
      },
      {
        type: "object",
        properties: {
          command: { type: "string", const: "replace" },
          path: { type: "string" },
          content: { type: "string" },
          from: {
            anyOf: [
              { type: "object", properties: { path: { type: "string" }, in: {} } },
              { type: "null" },
            ],
          },
          find: { type: "string" },
        },
      },
    ],
  };

  it("orders nested objects and keeps keys the schema doesn't name, last", () => {
    const stored = { from: { in: 3, path: "a.md" }, path: "b.md", extra: 1, command: "replace" };
    expect(JSON.stringify(orderLikeSchema(stored, write))).toBe(
      '{"command":"replace","path":"b.md","from":{"path":"a.md","in":3},"extra":1}',
    );
  });

  it("leaves arguments as they are with no schema", () => {
    expect(JSON.stringify(orderLikeSchema({ b: 1, a: 2 }, {}))).toBe('{"b":1,"a":2}');
  });
});
