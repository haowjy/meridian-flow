import { describe, expect, it } from "vitest";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import { findTextMatches, stripReadHashPrefixes } from "./find.js";
import type { BlockScope } from "./scope.js";

describe("findTextMatches", () => {
  it("matches a single-line body when the needle includes a read hash prefix", () => {
    const result = findInBodies(["The heavens rumbled..."], "63bf|The heavens rumbled...");

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

  it("drops a pure hash marker line from a pasted multi-line block", () => {
    const body = "The heavens rumbled...\nThen silence.";
    const result = findInBodies([body], `63bf|\n${body}`);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({
      rangeSource: body,
      matchStart: 0,
      matchEnd: body.length,
    });
  });

  it("matches multiple hash-prefixed block lines when the needle keeps the block separator", () => {
    const result = findInBodies(
      ["First line", "Second line"],
      "63bf|First line\n\n4abe|Second line",
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({
      startIndex: 0,
      endIndex: 1,
      rangeSource: "First line\n\nSecond line",
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

  it("returns not_found when a stripped hash-prefixed needle still has no body match", () => {
    const result = findInBodies(["Present body"], "63bf|Missing body");

    expect(result).toMatchObject({
      ok: false,
      code: "not_found",
      message: 'Could not find "63bf|Missing body" in the selected scope',
    });
  });

  it("preserves ambiguity after stripping a hash-prefixed needle", () => {
    const result = findInBodies(["Echo", "Echo"], "63bf|Echo");

    expect(result).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      count: 2,
    });
  });
});

describe("stripReadHashPrefixes", () => {
  it("strips at most one prefix per line", () => {
    expect(stripReadHashPrefixes("63bf|1a2b|text")).toBe("1a2b|text");
  });

  it("returns null when stripping would produce an empty needle", () => {
    expect(stripReadHashPrefixes("63bf|")).toBeNull();
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
