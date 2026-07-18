import { describe, expect, it } from "vitest";
import { validateContextEntryName, validateContextEntryPath } from "./context-entry-validation.js";

describe("context entry validation", () => {
  it("normalizes names and path segments", () => {
    expect(validateContextEntryName("  Chapter 3.md ")).toEqual({
      ok: true,
      value: "Chapter 3.md",
    });
    expect(validateContextEntryPath(" Act 2 / Chapter 3.md ")).toEqual({
      ok: true,
      value: "Act 2/Chapter 3.md",
    });
  });

  it.each([
    ["", "name/empty"],
    ["   ", "name/empty"],
    ["..", "name/reserved"],
    ["Chapter: 3", "name/invalid-character"],
    ["Act 2//Chapter 3", "path/empty-segment"],
    ["Act 2/   /Chapter 3", "path/empty-segment"],
    ["Act 2/", "path/trailing-separator"],
  ])("rejects %j with %s", (raw, reason) => {
    const result = raw.includes("/")
      ? validateContextEntryPath(raw)
      : validateContextEntryName(raw);
    expect(result).toMatchObject({ ok: false, reason });
  });

  it("supports an explicit scheme root and validates writer-visible roots", () => {
    expect(validateContextEntryPath("", { allowRoot: true })).toEqual({ ok: true, value: "" });
    expect(validateContextEntryPath("Manuscrpt/Chapter", { knownRoots: ["Manuscript"] })).toEqual({
      ok: false,
      reason: "path/unknown-root",
      segment: "Manuscrpt",
    });
  });
});
