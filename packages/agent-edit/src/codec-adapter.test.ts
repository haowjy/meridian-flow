import type { MarkupCodec, ParsedContent, PMNode } from "@meridian/markup";
import { describe, expect, it, vi } from "vitest";

import { createAgentEditCodec } from "./codec-adapter.js";

const [singleLineBlock, multilineBlock, emptyBlock] = ["one", "two", "three"].map(
  (name) => ({ name }) as unknown as PMNode,
) as [PMNode, PMNode, PMNode];
const blocks = [singleLineBlock, multilineBlock, emptyBlock];
const parsed = { blocks: [singleLineBlock] } as ParsedContent;

function fakeMarkupCodec(): MarkupCodec {
  return {
    parse: vi.fn(() => parsed),
    serialize: vi.fn(() => "serialized"),
    serializeBlock: vi.fn((block: PMNode) => bodyFor(block)),
    serializeBlocks: vi.fn((input: readonly PMNode[]) => input.map(bodyFor)),
  };
}

function bodyFor(block: PMNode): string {
  switch ((block as { name?: string }).name) {
    case "one":
      return "lone";
    case "two":
      return "console.log(1)\nconsole.log(2)";
    default:
      return "";
  }
}

describe("agent-edit codec adapter", () => {
  it("formats single-block bodies with agent-edit hash prefixes", () => {
    const markup = fakeMarkupCodec();
    const codec = createAgentEditCodec(markup);

    expect(codec.serializeBlock(singleLineBlock, "a1b2")).toBe("a1b2|lone");
    expect(codec.serializeBlock(multilineBlock, "c3d4")).toBe(
      "c3d4|\nconsole.log(1)\nconsole.log(2)",
    );
    expect(codec.serializeBlock(emptyBlock, "e5f6")).toBe("e5f6|");
    expect(markup.serializeBlock).toHaveBeenCalledTimes(3);
  });

  it("formats batch bodies with aligned hashes and an empty fallback hash", () => {
    const markup = fakeMarkupCodec();
    const codec = createAgentEditCodec(markup);

    expect(codec.serializeBlocks(blocks, ["a1b2", "c3d4"])).toEqual([
      "a1b2|lone",
      "c3d4|\nconsole.log(1)\nconsole.log(2)",
      "|",
    ]);
    expect(markup.serializeBlocks).toHaveBeenCalledWith(blocks);
  });
});
