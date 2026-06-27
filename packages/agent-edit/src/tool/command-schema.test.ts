// Write-command schema parity checks for the public package boundary.
import { describe, expect, it } from "vitest";

import { WriteCommandSchema, writeCommandCategory } from "./command-schema.js";

const validCommands = [
  { command: "create", file: "chapter.md" },
  { command: "create", file: "chapter.md", content: "# Chapter", overwrite: true },
  { command: "read", file: "chapter.md" },
  {
    command: "read",
    file: "chapter.md#scene",
    in: "a1b2..c3d4",
    around: "a1b2",
    format: "outline",
  },
  { command: "read", file: "chapter.md", in: 2 },
  { command: "read", file: "chapter.md", in: [1, "c3d4"] },
  { command: "insert", file: "chapter.md", content: "New paragraph.", after: "a1b2" },
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
  { command: "redo", file: "chapter.md", last: 1 },
  { command: "read", file: "chapter.md", documentId: "doc-1", tool_use_id: "call-1" },
] satisfies unknown[];

const intendedTightenings = [
  ["extra key", { command: "read", file: "chapter.md", extra: true }],
  ["old read spelling", { command: ["vi", "ew"].join(""), file: "chapter.md" }],
  ["read with content", { command: "read", file: "chapter.md", content: "ignored before" }],
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
] satisfies Array<[string, unknown]>;

describe("WriteCommandSchema", () => {
  it("accepts representative commands that the write tool supports", () => {
    for (const command of validCommands) {
      expect(WriteCommandSchema.parse(command)).toMatchObject(command);
    }
  });

  it("keeps resolver-supported positional and tuple scopes", () => {
    const scoped = WriteCommandSchema.parse({
      command: "replace",
      file: "chapter.md",
      content: "Beta",
      in: [1, "c3d4"],
    });

    expect(scoped.command).toBe("replace");
    if (scoped.command !== "replace") throw new Error("expected replace command");
    expect(scoped.in).toEqual([1, "c3d4"]);
  });

  it("rejects only the intended strict-schema tightenings", () => {
    expect(intendedTightenings.map(([label]) => label)).toEqual([
      "extra key",
      "old read spelling",
      "read with content",
      "replace with after",
      "replace with before",
      "insert with undo selector",
      "undo with content",
      "create with find",
    ]);

    for (const [, command] of intendedTightenings) {
      expect(WriteCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it("classifies query, mutating, and history commands", () => {
    expect(writeCommandCategory({ command: "read", file: "chapter.md" })).toBe("query");
    expect(writeCommandCategory({ command: "insert", file: "chapter.md", content: "Beta" })).toBe(
      "mutating",
    );
    expect(writeCommandCategory({ command: "undo", file: "chapter.md" })).toBe("history");
  });
});
