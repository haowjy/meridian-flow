// Read and write command schemas: the cross-field selector rules, one row each.
import { describe, expect, it } from "vitest";

import {
  ReadCommandSchema,
  ReadToolInputSchema,
  WriteCommandSchema,
  WriteToolInputSchema,
} from "./command-schema.js";

const validWrites = [
  { command: "replace", file: "chapter.md#scene", content: "Beta" },
  { command: "remove", file: "chapter.md", in: [1, "c3d4"] },
  { command: "undo", file: "chapter.md", since: "w1", to: "w3" },
  { command: "replace", file: "chapter.md", in: [2, 4], from: { path: "kb://lin.md", in: "a1b2" } },
  { command: "copy", file: "duel.md", from: { path: "ch11#the-midnight-duel" } },
] satisfies unknown[];

/** Each rule the schema refuses, with the argument the issue lands on. */
const selectorRules = [
  ["read in + #fragment", { file: "c.md#s", in: 1 }, "in"],
  [
    "insert after + before",
    { command: "insert", file: "c.md", content: "x", after: "a", before: "b" },
    "before",
  ],
  ["remove with no selector", { command: "remove", file: "c.md" }, "file"],
  [
    "insert with content and from",
    { command: "insert", file: "c.md", content: "x", from: { path: "a" } },
    "from",
  ],
  [
    "from.in with a #fragment",
    { command: "insert", file: "c.md", from: { path: "a#s", in: 1 } },
    "from.in",
  ],
  ["since without to", { command: "undo", file: "c.md", since: "w1" }, "since"],
  ["since after to", { command: "redo", file: "c.md", since: "w4", to: "w2" }, "since"],
  ["last with all", { command: "undo", file: "c.md", last: 2, all: true }, "all"],
] as const;

describe("command schemas", () => {
  it("accepts the PR's new selector shapes", () => {
    for (const command of validWrites) expect(WriteCommandSchema.parse(command)).toEqual(command);
  });

  it.each(selectorRules)("refuses %s", (_label, input, field) => {
    const schema = "command" in input ? WriteCommandSchema : ReadCommandSchema;
    const parsed = schema.safeParse(input);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain(field);
  });

  it("names the document `path` on the model-facing inputs and refuses host fields", () => {
    const parsed = WriteToolInputSchema.safeParse({ command: "remove", path: "c.md" });
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["path"]]);
    expect(ReadToolInputSchema.safeParse({ path: "c.md", documentId: "d" }).success).toBe(false);
  });

  it("points a sectioned delete to `remove`, and keeps move and delete out of the engine", () => {
    const sectioned = WriteToolInputSchema.safeParse({ command: "delete", path: "c.md#scene" });
    expect(sectioned.error?.issues).toEqual([
      expect.objectContaining({ path: ["path"], message: expect.stringContaining("`remove`") }),
    ]);
    const move = { command: "move", from: { path: "a.md" }, path: "b.md" };
    expect(WriteToolInputSchema.parse(move)).toEqual(move);
    expect(WriteCommandSchema.safeParse({ command: "delete", file: "c.md" }).success).toBe(false);
  });
});
