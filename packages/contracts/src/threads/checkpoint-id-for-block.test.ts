/**
 * Purpose: Verifies the canonical checkpoint id reader used by reducers and chat partitioning.
 * Key decision: checkpoint detection depends only on custom-block `content.checkpoint.id`,
 * not on the broader component-render payload shape.
 */
import { describe, expect, it } from "vitest";

import type { Block } from "./index";
import { checkpointIdForBlock } from "./index";

function blockWithContent(
  content: Block["content"],
  blockType: Block["blockType"] = "custom",
): Block {
  return {
    id: "block_1",
    turnId: "turn_1",
    responseId: null,
    blockType,
    sequence: 0,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("checkpointIdForBlock", () => {
  it("returns the checkpoint id from a custom block", () => {
    expect(checkpointIdForBlock(blockWithContent({ checkpoint: { id: "checkpoint_1" } }))).toBe(
      "checkpoint_1",
    );
  });

  it("returns null for a custom block without a non-empty checkpoint id", () => {
    expect(checkpointIdForBlock(blockWithContent({ checkpoint: {} }))).toBeNull();
    expect(checkpointIdForBlock(blockWithContent({ checkpoint: { id: "" } }))).toBeNull();
  });

  it("returns null for non-custom blocks", () => {
    expect(
      checkpointIdForBlock(blockWithContent({ checkpoint: { id: "checkpoint_1" } }, "text")),
    ).toBeNull();
  });

  it("returns null for non-object block content", () => {
    expect(checkpointIdForBlock(blockWithContent(null))).toBeNull();
    expect(checkpointIdForBlock(blockWithContent("checkpoint_1"))).toBeNull();
  });
});
