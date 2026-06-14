/**
 * Purpose: Guards the canonical block-to-plain-text contract shared by live projection,
 * durable read-model projection, and UI fallback rendering.
 * Key decision: prose detection is based on the block contract, not ad-hoc renderer or projector type branches.
 */
import { describe, expect, it } from "vitest";

import { blockPlainText } from "./index";

describe("blockPlainText", () => {
  it("returns string content for text blocks", () => {
    expect(blockPlainText("text", "Hello there")).toBe("Hello there");
  });

  it("returns wrapped text content for reasoning blocks", () => {
    expect(blockPlainText("reasoning", { text: "Considering options" })).toBe(
      "Considering options",
    );
  });

  it("returns wrapped text content for thinking blocks", () => {
    expect(blockPlainText("thinking", { text: "Thinking aloud" })).toBe("Thinking aloud");
  });

  it("ignores provider round-trip data around reasoning text", () => {
    expect(
      blockPlainText("reasoning", {
        text: "Provider reasoning",
        providerOptions: { encryptedThinking: "opaque-provider-payload" },
      }),
    ).toBe("Provider reasoning");
  });

  it("returns null for non-prose block types", () => {
    expect(blockPlainText("tool_use", { text: "not user-facing prose" })).toBeNull();
  });

  it("returns null for prose block objects without string text", () => {
    expect(blockPlainText("reasoning", { text: null })).toBeNull();
    expect(blockPlainText("reasoning", { summary: "summary only" })).toBeNull();
  });

  it("returns null for array content", () => {
    expect(blockPlainText("reasoning", ["not", "a", "plain", "text", "object"])).toBeNull();
  });
});
