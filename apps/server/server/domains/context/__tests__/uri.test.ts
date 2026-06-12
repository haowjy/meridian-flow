import { describe, expect, it } from "vitest";
import { parseContextUri } from "../context/uri.js";

describe("parseContextUri", () => {
  it("defaults bare paths to fs1://", () => {
    const result = parseContextUri("data/results.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scheme).toBe("fs1");
    expect(result.value.canonical).toBe("fs1://data/results.csv");
  });

  it("normalizes leading/duplicate/trailing slashes and . segments", () => {
    const cases: Array<[string, string]> = [
      ["fs1:///data/results.csv", "fs1://data/results.csv"],
      ["kb://protocols/", "kb://protocols"],
      ["kb://./protocols/blot.md", "kb://protocols/blot.md"],
      ["work://", "work://"],
    ];
    for (const [input, expected] of cases) {
      const result = parseContextUri(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.canonical).toBe(expected);
    }
  });

  it("rejects path traversal", () => {
    const result = parseContextUri("fs1://../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_uri");
  });

  it("rejects unknown schemes", () => {
    const result = parseContextUri("s3://bucket/key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_uri");
      if (result.error.code === "invalid_uri") {
        expect(result.error.reason).toContain("s3");
      }
    }
  });

  it("rejects empty input", () => {
    const result = parseContextUri("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects a scheme-like prefix that is not scheme://", () => {
    for (const input of ["kb:notes.md", "package:/foo", "fs1:x"]) {
      const result = parseContextUri(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_uri");
    }
  });

  it("still treats slash-only bare paths as fs1://", () => {
    const result = parseContextUri("data/sub/results.csv");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.canonical).toBe("fs1://data/sub/results.csv");
  });

  it("treats a scheme root as an empty path", () => {
    const result = parseContextUri("user://");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe("");
      expect(result.value.canonical).toBe("user://");
    }
  });
});
