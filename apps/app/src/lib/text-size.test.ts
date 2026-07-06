import { describe, expect, it } from "vitest";

import { DEFAULT_TEXT_SIZE, normalizeTextSize } from "./text-size";

describe("normalizeTextSize", () => {
  it("keeps supported text sizes", () => {
    expect(normalizeTextSize("sm")).toBe("sm");
    expect(normalizeTextSize("md")).toBe("md");
    expect(normalizeTextSize("lg")).toBe("lg");
  });

  it("falls back to medium for missing or unknown values", () => {
    expect(normalizeTextSize(null)).toBe(DEFAULT_TEXT_SIZE);
    expect(normalizeTextSize("xl")).toBe(DEFAULT_TEXT_SIZE);
  });
});
