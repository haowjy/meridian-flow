import { describe, expect, it } from "vitest";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import { findTextMatches, reconstructReadFormatNeedle } from "./find.js";
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

  it("matches two single-line blocks separated by read hash prefixes", () => {
    const result = findInBodies(["First.", "Second."], "63bf|First.\nde0e|Second.");

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

  it("preserves soft breaks inside a hash-prefixed multi-line block", () => {
    const body = "Line A\nLine B";
    const result = findInBodies([body], `63bf|\n${body}`);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({
      startIndex: 0,
      endIndex: 0,
      rangeSource: body,
      matchEnd: body.length,
    });
  });

  it("keeps an empty block in the middle of a hash-prefixed multi-block needle", () => {
    const result = findInBodies(["A", "", "B"], "63bf|A\na1b2|\nde0e|B");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0]).toMatchObject({
      startIndex: 0,
      endIndex: 2,
      rangeSource: "A\n\n\n\nB",
      matchEnd: "A\n\n\n\nB".length,
    });
  });

  it("returns not_found for a needle that is only an empty read-format block", () => {
    const result = findInBodies([""], "a1b2|");

    expect(result).toMatchObject({
      ok: false,
      code: "not_found",
      message: 'Could not find "a1b2|" in the selected scope',
    });
  });

  it("does not reconstruct when the first line is not a read marker", () => {
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

  it("returns not_found when a reconstructed hash-prefixed needle still has no body match", () => {
    const result = findInBodies(["Present body"], "63bf|Missing body");

    expect(result).toMatchObject({
      ok: false,
      code: "not_found",
      message: 'Could not find "63bf|Missing body" in the selected scope',
    });
  });

  it("preserves ambiguity after reconstructing a hash-prefixed needle", () => {
    const result = findInBodies(["Echo", "Echo"], "63bf|Echo");

    expect(result).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      count: 2,
    });
  });
});

describe("reconstructReadFormatNeedle", () => {
  it("reconstructs single-line, multi-line, multi-block, and empty-block bodies", () => {
    expect(reconstructReadFormatNeedle("63bf|1a2b|text")).toBe("1a2b|text");
    expect(reconstructReadFormatNeedle("63bf|\nThe heavens\nacross")).toBe("The heavens\nacross");
    expect(reconstructReadFormatNeedle("63bf|First.\nde0e|Second.")).toBe("First.\n\nSecond.");
    expect(reconstructReadFormatNeedle("63bf|A\na1b2|\nde0e|B")).toBe("A\n\n\n\nB");
  });

  it("returns null when reconstruction would be empty or the first line is not a marker", () => {
    expect(reconstructReadFormatNeedle("63bf|")).toBeNull();
    expect(reconstructReadFormatNeedle("Plain text\nde0e|tail")).toBeNull();
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
