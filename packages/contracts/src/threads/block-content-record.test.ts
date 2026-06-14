/**
 * Purpose: Verifies the shared block content record helper used by protocol reducers and renderers.
 * Key decision: the helper is intentionally forgiving at read time, returning an empty record for
 * every non-plain-object block content shape.
 */
import { describe, expect, it } from "vitest";

import type { Block } from "./index";
import { blockContentRecord } from "./index";

function blockWithContent(content: Block["content"]): Block {
  return {
    id: "block_1",
    turnId: "turn_1",
    responseId: null,
    blockType: "tool_use",
    sequence: 0,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("blockContentRecord", () => {
  it("returns object content as a JSON record", () => {
    expect(
      blockContentRecord(blockWithContent({ toolName: "search", input: { q: "hello" } })),
    ).toEqual({
      toolName: "search",
      input: { q: "hello" },
    });
  });

  it("returns an empty record for non-object content", () => {
    expect(blockContentRecord(blockWithContent("plain text"))).toEqual({});
    expect(blockContentRecord(blockWithContent(null))).toEqual({});
    expect(blockContentRecord(blockWithContent(["array content"]))).toEqual({});
  });
});
