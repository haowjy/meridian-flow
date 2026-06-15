import { describe, expect, it } from "vitest";
import { parseContextUri, parseUnifiedContextUri } from "../context/uri.js";

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

describe("parseUnifiedContextUri", () => {
  it("defaults bare paths to manuscript://", () => {
    const result = parseUnifiedContextUri("chapter-1.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scheme).toBe("manuscript");
    expect(result.value.canonical).toBe("manuscript://chapter-1.md");
  });

  it("parses work authority for uploads://", () => {
    const workId = "00000000-0000-4000-8000-0000000000ab";
    const result = parseUnifiedContextUri(`uploads://${workId}/file.txt`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authority).toBe(workId);
    expect(result.value.canonical).toBe(`uploads://${workId}/file.txt`);
  });

  it("rejects authority on manuscript://", () => {
    const workId = "00000000-0000-4000-8000-0000000000ab";
    const result = parseUnifiedContextUri(`manuscript://${workId}/chapter-1.md`);
    expect(result.ok).toBe(false);
  });

  it("rejects a UUID-shaped but invalid work authority (mistyped Work id)", () => {
    // Full 8-4-4-4-12 shape, but non-hex chars in the last group → not a valid UUID.
    const result = parseUnifiedContextUri("work://12345678-1234-1234-1234-1234567890zz/notes.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_uri");
      if (result.error.code === "invalid_uri") {
        expect(result.error.reason).toContain("Invalid Work authority");
      }
    }
  });

  it("treats legitimate short hyphenated first segments as path, not authority", () => {
    for (const uri of ["work://dead-beef/notes.md", "uploads://2024-assets/img.png"]) {
      const result = parseUnifiedContextUri(uri);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.authority).toBeNull();
    }
  });

  it("still treats non-authority work paths with slashes as paths", () => {
    const result = parseUnifiedContextUri("work://notes/sub/file.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authority).toBeNull();
    expect(result.value.path).toBe("notes/sub/file.md");
  });
});
