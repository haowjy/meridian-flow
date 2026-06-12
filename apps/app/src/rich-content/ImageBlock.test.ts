// @ts-nocheck
/**
 * Unit tests for parseImageBlockContent — the pure wire-payload parser.
 *
 * Imports from `image-block-utils` (no React) so these run cleanly in the
 * node vitest environment without browser or jsdom setup.
 *
 * Component render tests (loading state, error fallback, img tag) belong in
 * an e2e / browser-test suite when that environment is wired up.
 */
import { describe, expect, it } from "vitest";

import { parseImageBlockContent } from "./image-block-utils";

describe("parseImageBlockContent", () => {
  it("returns null for null input", () => {
    expect(parseImageBlockContent(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseImageBlockContent("string")).toBeNull();
    expect(parseImageBlockContent(42)).toBeNull();
  });

  it("returns null when url is missing", () => {
    expect(parseImageBlockContent({ alt: "something" })).toBeNull();
  });

  it("returns null when url is empty string", () => {
    expect(parseImageBlockContent({ url: "" })).toBeNull();
  });

  it("returns content from a flat url/alt/caption shape", () => {
    const result = parseImageBlockContent({
      url: "https://example.com/img.png",
      alt: "A scan",
      caption: "Bone scaffold",
    });
    expect(result).toEqual({
      url: "https://example.com/img.png",
      alt: "A scan",
      caption: "Bone scaffold",
    });
  });

  it("omits undefined alt/caption when not present", () => {
    const result = parseImageBlockContent({ url: "https://example.com/img.png" });
    expect(result).toEqual({
      url: "https://example.com/img.png",
      alt: undefined,
      caption: undefined,
    });
  });

  it("reads url from nested output shape (tool_result content wrapper)", () => {
    // The orchestrator wraps tool output as content.output; parseImageBlockContent
    // reads through that layer automatically.
    const result = parseImageBlockContent({
      toolName: "show_demo_image",
      output: {
        url: "https://example.com/nested.png",
        alt: "Nested alt",
        caption: "Nested caption",
      },
    });
    expect(result).toEqual({
      url: "https://example.com/nested.png",
      alt: "Nested alt",
      caption: "Nested caption",
    });
  });

  it("returns null when nested output has no url", () => {
    const result = parseImageBlockContent({
      toolName: "show_demo_image",
      output: { alt: "only alt" },
    });
    expect(result).toBeNull();
  });

  it("ignores non-string alt/caption fields (type-safe coercion)", () => {
    const result = parseImageBlockContent({
      url: "https://example.com/img.png",
      alt: 42,
      caption: null,
    });
    expect(result).toEqual({
      url: "https://example.com/img.png",
      alt: undefined,
      caption: undefined,
    });
  });

  it("prefers nested output.url over top-level url when both exist", () => {
    // When the object has an `output` field, we read from it regardless
    // of what's at the top level.
    const result = parseImageBlockContent({
      url: "https://top-level.example.com/img.png",
      output: { url: "https://nested.example.com/img.png", alt: "nested" },
    });
    expect(result?.url).toBe("https://nested.example.com/img.png");
  });
});
