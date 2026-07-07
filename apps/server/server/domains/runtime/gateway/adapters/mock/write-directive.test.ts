import { describe, expect, it } from "vitest";
import { parseWriteDirective } from "./write-directive.js";

describe("parseWriteDirective", () => {
  it("returns null when no directive is present", () => {
    expect(parseWriteDirective("Phase 7 final gate")).toBeNull();
    expect(parseWriteDirective("Acknowledged: hello")).toBeNull();
  });

  it("parses a target uri", () => {
    expect(parseWriteDirective("[[write manuscript://chapter-2.md]]")).toEqual({
      path: "manuscript://chapter-2.md",
      overwrite: false,
    });
  });

  it("parses overwrite when requested", () => {
    expect(
      parseWriteDirective("Phase 7 final gate [[write manuscript://chapter-1.md overwrite]]"),
    ).toEqual({
      path: "manuscript://chapter-1.md",
      overwrite: true,
    });
  });

  it("is case-insensitive on the write keyword", () => {
    expect(parseWriteDirective("[[WRITE kb://notes.md]]")).toEqual({
      path: "kb://notes.md",
      overwrite: false,
    });
  });
});
