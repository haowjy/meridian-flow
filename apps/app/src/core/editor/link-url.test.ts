import { describe, expect, it } from "vitest";

import { normalizeLinkHref } from "@/core/editor/link-url";

describe("normalizeLinkHref", () => {
  it.each([
    ["example.com", "https://example.com"],
    [" example.com/path ", "https://example.com/path"],
    ["//example.com/path", "https://example.com/path"],
    ["http://example.com", "http://example.com"],
    ["https://example.com", "https://example.com"],
    ["mailto:writer@example.com", "mailto:writer@example.com"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeLinkHref(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "ftp://example.com",
    "https://",
    "mailto:",
    "://example.com",
  ])("rejects %s", (input) => {
    expect(normalizeLinkHref(input)).toBeNull();
  });
});
