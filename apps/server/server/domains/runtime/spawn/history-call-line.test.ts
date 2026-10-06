/** One tool call as history writes it (D48); the history contract suites pin the full lines. */
import { describe, expect, it } from "vitest";
import { CALL_LINE_CAP, orderLikeSchema, shortenCallArgs } from "./history-call-line.js";

const words = (count: number, word = "word") => Array.from({ length: count }, () => word).join(" ");

describe("shortenCallArgs", () => {
  it("shortens further rather than dropping keys when a call is over the line cap", () => {
    const args = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`field${i}`, words(40, "long")]),
    );
    const shortened = shortenCallArgs("work", args);
    expect(Object.keys(shortened)).toEqual(Object.keys(args));
    expect(`work(${JSON.stringify(shortened)})`.length).toBeLessThanOrEqual(CALL_LINE_CAP);
    expect(shortened.field0).toBe("…(40 words)");
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
});
