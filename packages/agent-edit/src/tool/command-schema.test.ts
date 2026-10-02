// Read and write command schema checks for the engine and model-facing contracts.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ReadCommandSchema,
  ReadToolInputSchema,
  WriteCommandSchema,
  WriteToolInputSchema,
} from "./command-schema.js";

const validReads = [
  { file: "chapter.md" },
  { file: "chapter.md#scene", format: "outline" },
  { file: "chapter.md", around: "a1b2" },
  { file: "chapter.md", in: 2, format: "full" },
  { file: "chapter.md", in: [1, "c3d4"] },
  { file: "chapter.md", documentId: "doc-1", tool_use_id: "call-1" },
] satisfies unknown[];

const invalidReads = [
  ["extra key", { file: "chapter.md", extra: true }],
  ["a command", { command: "read", file: "chapter.md" }],
  ["content", { file: "chapter.md", content: "ignored before" }],
  ["the removed auto format", { file: "chapter.md", format: "auto" }],
  ["block number zero", { file: "chapter.md", in: 0 }],
  ["a negative range end", { file: "chapter.md", in: [1, -2] }],
  ["a fractional block number", { file: "chapter.md", in: 1.5 }],
  ["a one-item range", { file: "chapter.md", in: [1] }],
  ["an empty block hash", { file: "chapter.md", in: "" }],
] satisfies Array<[string, unknown]>;

const validWrites = [
  { command: "create", file: "chapter.md" },
  { command: "create", file: "chapter.md", content: "# Chapter", overwrite: true },
  { command: "insert", file: "chapter.md", content: "New paragraph.", after: "a1b2" },
  { command: "insert", file: "chapter.md", content: "New paragraph.", before: "c3d4" },
  { command: "insert", file: "chapter.md", content: "New paragraph.", find: "Alpha", in: [1, 3] },
  { command: "insert", file: "chapter.md", content: "x", find: "Alpha", around: "a1b2", all: true },
  { command: "insert", file: "chapter.md#scene", content: "x", find: "Alpha" },
  { command: "replace", file: "chapter.md", content: "", in: 1 },
  { command: "remove", file: "chapter.md", in: "a1b2" },
  { command: "remove", file: "chapter.md", in: [1, "c3d4"] },
  { command: "remove", file: "chapter.md#scene" },
  { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha", in: ["a1b2", "c3d4"] },
  { command: "replace", file: "chapter.md", content: "Beta", find: "Alpha", around: "a1b2" },
  { command: "replace", file: "chapter.md#scene", content: "Beta", find: "Alpha", all: true },
  { command: "replace", file: "chapter.md#scene", content: "Beta" },
  { command: "undo", file: "chapter.md" },
  { command: "redo", file: "chapter.md", to: "w3" },
  { command: "undo", file: "chapter.md", since: "w1", to: "w3" },
  { command: "redo", file: "chapter.md", since: "w2", to: "w2" },
  { command: "redo", file: "chapter.md", last: 1 },
  { command: "redo", file: "chapter.md", all: true },
  { command: "insert", file: "chapter.md", content: "x", documentId: "d", tool_use_id: "c" },
] satisfies unknown[];

const invalidWrites = [
  ["a read", { command: "read", file: "chapter.md" }],
  ["the removed diff", { command: "diff" }],
  ["the renamed delete", { command: "delete", file: "chapter.md", in: 1 }],
  ["insert extra key", { command: "insert", file: "chapter.md", content: "Beta", extra: true }],
  [
    "replace with after",
    { command: "replace", file: "chapter.md", content: "Beta", after: "a1b2" },
  ],
  [
    "replace with before",
    { command: "replace", file: "chapter.md", content: "Beta", before: "a1b2" },
  ],
  [
    "insert with undo selector",
    { command: "insert", file: "chapter.md", content: "Beta", to: "w1" },
  ],
  ["undo with content", { command: "undo", file: "chapter.md", content: "ignored before" }],
  ["create with find", { command: "create", file: "chapter.md", find: "ignored before" }],
  ["remove with content", { command: "remove", file: "chapter.md", in: 1, content: "" }],
  ["remove at block zero", { command: "remove", file: "chapter.md", in: 0 }],
  ["insert with empty content", { command: "insert", file: "chapter.md", content: "" }],
  ["insert with empty find", { command: "insert", file: "chapter.md", content: "x", find: "" }],
  ["replace with empty find", { command: "replace", file: "chapter.md", content: "", find: "" }],
] satisfies Array<[string, unknown]>;

/**
 * The selector matrix: every pair the rule refuses, with the argument the
 * issue lands on and its message. Parsed through the engine schema; the tool
 * schema reports the same issues with `path` for `file`.
 */
const ONE_SCOPE = "Use one of in, around or a #fragment";
const selectorMatrix = [
  ["read in + around", { file: "c.md", in: 1, around: "a1" }, "around", ONE_SCOPE],
  ["read in + #fragment", { file: "c.md#s", in: 1 }, "in", ONE_SCOPE],
  ["read around + #fragment", { file: "c.md#s", around: "a1" }, "around", ONE_SCOPE],
  ...(["insert", "replace"] as const).flatMap((command) => {
    const base = { command, file: "c.md", content: "x", find: "Alpha" };
    return [
      [`${command} in + around`, { ...base, in: 1, around: "a1" }, "around", ONE_SCOPE],
      [`${command} in + #fragment`, { ...base, file: "c.md#s", in: 1 }, "in", ONE_SCOPE],
      [
        `${command} around + #fragment`,
        { ...base, file: "c.md#s", around: "a1" },
        "around",
        ONE_SCOPE,
      ],
      [
        `${command} around without find`,
        {
          command,
          file: "c.md",
          content: "x",
          ...(command === "replace" ? { in: 1 } : {}),
          around: "a1",
        },
        "around",
        command === "insert"
          ? "around narrows find; add find or use after or before"
          : "around narrows find; add find or use in",
      ],
      [
        `${command} all without find`,
        {
          command,
          file: "c.md",
          content: "x",
          ...(command === "replace" ? { in: 1 } : {}),
          all: true,
        },
        "all",
        "all applies to find matches",
      ],
    ] as const;
  }),
  [
    "insert in without find",
    { command: "insert", file: "c.md", content: "x", in: 1 },
    "in",
    "insert positions with after, before or find",
  ],
  [
    "insert #fragment without find",
    { command: "insert", file: "c.md#s", content: "x" },
    "file",
    "insert positions with after, before or find",
  ],
  [
    "insert after + before",
    { command: "insert", file: "c.md", content: "x", after: "a1", before: "b2" },
    "before",
    "Use after or before, not both",
  ],
  [
    "insert after + find",
    { command: "insert", file: "c.md", content: "x", after: "a1", find: "Alpha" },
    "find",
    "Use after or before to position by block, or find to position by text, not both",
  ],
  [
    "insert before + find",
    { command: "insert", file: "c.md", content: "x", before: "a1", find: "Alpha" },
    "find",
    "Use after or before to position by block, or find to position by text, not both",
  ],
  [
    "replace with no selector",
    { command: "replace", file: "c.md", content: "x" },
    "",
    "replace needs `in`, `find` or a #heading-slug in path",
  ],
  [
    "remove with in + #fragment",
    { command: "remove", file: "c.md#s", in: 1 },
    "in",
    "remove needs exactly one of `in` or a #heading-slug in path",
  ],
  [
    "remove with no selector",
    { command: "remove", file: "c.md" },
    "file",
    "remove needs exactly one of `in` or a #heading-slug in path",
  ],
] as const;

describe("ReadCommandSchema", () => {
  it("accepts reads without a command", () => {
    for (const read of validReads) expect(ReadCommandSchema.parse(read)).toEqual(read);
  });
  it.each(invalidReads)("rejects %s", (_label, read) => {
    expect(ReadCommandSchema.safeParse(read).success).toBe(false);
  });
});

describe("WriteCommandSchema", () => {
  it("accepts every mutation command", () => {
    for (const command of validWrites) expect(WriteCommandSchema.parse(command)).toEqual(command);
  });
  it.each(invalidWrites)("rejects %s", (_label, command) => {
    expect(WriteCommandSchema.safeParse(command).success).toBe(false);
  });
});

describe("the selector rule", () => {
  it.each(selectorMatrix)("refuses %s", (_label, input, field, message) => {
    const schema = "command" in input ? WriteCommandSchema : ReadCommandSchema;
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message]),
    ).toContainEqual([field, message]);
  });

  it("reports the document path as `path` on the tool inputs", () => {
    const parsed = WriteToolInputSchema.safeParse({ command: "remove", path: "c.md" });
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["path"]]);
    const read = ReadToolInputSchema.safeParse({ path: "c.md#s", in: 1 });
    expect(read.error?.issues.map((issue) => issue.message)).toEqual([ONE_SCOPE]);
  });
});

describe("the undo and redo selector rule", () => {
  it.each([
    ["the old from range start", { to: "w3", from: "w1" }, "", 'Unrecognized key: "from"'],
    ["since without to", { since: "w1" }, "since", "since starts a range; add to"],
    ["to with last", { to: "w3", last: 2 }, "last", "Use one of to, last or all"],
    ["last with all", { last: 2, all: true }, "all", "Use one of to, last or all"],
    ["a malformed handle", { to: "3" }, "to", 'expected a write handle such as w3, got "3"'],
    ["since after to", { since: "w4", to: "w2" }, "since", "since must not come after to"],
  ] as const)("refuses %s", (_label, selector, field, message) => {
    for (const command of ["undo", "redo"] as const) {
      const parsed = WriteCommandSchema.safeParse({ command, file: "c.md", ...selector });
      expect(parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        [field, message],
      ]);
    }
  });
});

describe("model-facing tool inputs", () => {
  it("name the document path and carry no host fields", () => {
    expect(ReadToolInputSchema.parse({ path: "chapter.md", in: 1 })).toEqual({
      path: "chapter.md",
      in: 1,
    });
    expect(WriteToolInputSchema.parse({ command: "remove", path: "chapter.md", in: 1 })).toEqual({
      command: "remove",
      path: "chapter.md",
      in: 1,
    });
    for (const hostOnly of [{ file: "chapter.md" }, { documentId: "d" }, { tool_use_id: "c" }]) {
      expect(ReadToolInputSchema.safeParse({ path: "chapter.md", ...hostOnly }).success).toBe(
        false,
      );
    }
    expect(ReadToolInputSchema.safeParse({ path: "" }).success).toBe(false);
  });

  it("publish `in` as one compact type with one description", () => {
    const published = JSON.stringify(
      z.toJSONSchema(ReadToolInputSchema, {
        io: "input",
        override(ctx) {
          const schema = ctx.jsonSchema as Record<string, unknown>;
          const replacement = schema.modelJsonSchema;
          if (!replacement) return;
          const { description } = schema;
          for (const key of Object.keys(schema)) delete schema[key];
          Object.assign(schema, replacement, description ? { description } : {});
        },
      }),
    );
    expect(published).toContain(
      '"in":{"anyOf":[{"type":["string","integer"]},{"type":"array","items":{"type":["string","integer"]},"minItems":2,"maxItems":2}],"description":"Block hash, 1-based block number, or an inclusive [start, end] range of either. Not with `around` or a `#fragment`."}',
    );
  });
});
