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
  { file: "chapter.md#scene", in: "a1b2", around: "a1b2", format: "outline" },
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
  {
    command: "insert",
    file: "chapter.md",
    content: "New paragraph.",
    find: "Alpha",
    in: [1, 3],
    around: "a1b2",
    all: true,
  },
  { command: "replace", file: "chapter.md", content: "", in: 1 },
  { command: "remove", file: "chapter.md", in: "a1b2" },
  { command: "remove", file: "chapter.md", in: [1, "c3d4"] },
  { command: "remove", file: "chapter.md#scene" },
  {
    command: "replace",
    file: "chapter.md",
    content: "Beta",
    find: "Alpha",
    in: ["a1b2", "c3d4"],
    around: "a1b2",
    all: true,
  },
  { command: "undo", file: "chapter.md" },
  { command: "undo", file: "chapter.md", to: "w3", from: "w1", last: 2, all: true },
  { command: "redo", file: "chapter.md", to: "w3" },
  { command: "redo", file: "chapter.md", from: "w1" },
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
] satisfies Array<[string, unknown]>;

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
