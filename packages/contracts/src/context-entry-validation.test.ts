import { describe, expect, it } from "vitest";
import { validateContextEntryName, validateContextEntryPath } from "./context-entry-validation.js";

describe("context entry validation", () => {
  it.each(["Drafts/@notes.md"])("reserves authority-like segment in %j", (raw) => {
    const result = raw.includes("/")
      ? validateContextEntryPath(raw)
      : validateContextEntryName(raw);
    expect(result).toEqual({
      ok: false,
      reason: "name/reserved-authority-qualifier",
      segment: raw.split("/").find((segment) => segment.startsWith("@")),
    });
  });

  it.each([
    ["..", "name/reserved"],
    ["Chapter: 3", "name/invalid-character"],
    ["Act 2//Chapter 3", "path/empty-segment"],
  ])("rejects %j with %s", (raw, reason) => {
    const result = raw.includes("/")
      ? validateContextEntryPath(raw)
      : validateContextEntryName(raw);
    expect(result).toMatchObject({ ok: false, reason });
  });
});
