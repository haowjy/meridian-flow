import { describe, expect, it } from "vitest";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import { findTextMatches } from "./find.js";
import type { BlockScope } from "./scope.js";

describe("findTextMatches", () => {
  it("matches an exact single-line body", () => {
    const result = findInBodies(["The heavens rumbled..."], "The heavens rumbled...");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      startIndex: 0,
      endIndex: 0,
      matchStart: 0,
      matchEnd: "The heavens rumbled...".length,
    });
  });

  it("matches an exact multiline body", () => {
    const body = "The heavens rumbled...\nThen silence.";
    const result = findInBodies([body], body);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({
      rangeSource: body,
      matchStart: 0,
      matchEnd: body.length,
    });
  });

  it("matches exact bodies across blocks", () => {
    const result = findInBodies(["First.", "Second."], "First.\n\nSecond.");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({
      startIndex: 0,
      endIndex: 1,
      rangeSource: "First.\n\nSecond.",
      matchStart: 0,
      matchEnd: "First.\n\nSecond.".length,
    });
  });

  it("keeps an empty block in the middle of an exact multi-block needle", () => {
    const result = findInBodies(["A", "", "B"], "A\n\n\n\nB");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({
      startIndex: 0,
      endIndex: 2,
      rangeSource: "A\n\n\n\nB",
      matchEnd: "A\n\n\n\nB".length,
    });
  });

  it("does not reinterpret mixed prose and hash-shaped lines", () => {
    const result = findInBodies(["tail"], "Plain text\nde0e|tail");

    expect(result).toMatchObject({
      ok: false,
      code: "not_found",
      message: 'Could not find "Plain text\nde0e|tail" in the selected scope',
    });
  });

  it("keeps raw document pipes literal", () => {
    const result = findInBodies(["key|value"], "key|value");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({ rangeSource: "key|value" });
  });

  it("keeps hash-shaped raw document content literal when literal matching succeeds", () => {
    const result = findInBodies(["abcd|note"], "abcd|note");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({
      rangeSource: "abcd|note",
      matchEnd: "abcd|note".length,
    });
  });

  it("preserves ambiguity for an exact needle", () => {
    const result = findInBodies(["Echo", "Echo"], "Echo");

    expect(result).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      count: 2,
    });
  });
});

function findInBodies(bodies: string[], find: string, all = false) {
  const blocks = bodies.map((_, index) => ({ index }) as unknown as BlockRef);
  const ctx = {
    doc: {} as DocHandle,
    codec: {} as AgentEditCodec,
    model: {
      getBlocks: () => blocks,
      serializeBlockBodies: (_doc, _codec, selected) =>
        selected.map((block) => bodies[blocks.indexOf(block)] ?? ""),
    } satisfies Partial<AgentEditModel> as unknown as AgentEditModel,
  };
  const scope: BlockScope = {
    kind: "document",
    blocks,
    startIndex: 0,
    endIndex: blocks.length - 1,
  };
  return findTextMatches(ctx, scope, find, all);
}
