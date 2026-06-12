/**
 * Unit tests for pure core-tool algorithms. These protect behavior that lib
 * wiring depends on without constructing app-layer adapters.
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyEditRanges,
  countOccurrences,
  formatWithLineNumbers,
  MAX_READ_BYTES,
  remainingBashTimeoutSeconds,
  resolveBashTimeoutSeconds,
  resolveEditRanges,
  TRUNCATION_MARKER,
  truncateForRead,
} from "./index.js";

describe("core edit algorithm", () => {
  it("resolves unique ranges and applies them left-to-right", () => {
    const ranges = resolveEditRanges("alpha beta gamma", [
      { oldText: "gamma", newText: "delta" },
      { oldText: "alpha", newText: "omega" },
    ]);

    expect(ranges).toEqual([
      { start: 11, end: 16, newText: "delta" },
      { start: 0, end: 5, newText: "omega" },
    ]);
    if ("message" in ranges) throw new Error(ranges.message);
    expect(applyEditRanges("alpha beta gamma", ranges)).toBe("omega beta delta");
  });

  it("rejects missing, ambiguous, and overlapping edits", () => {
    expect(countOccurrences("aaa", "aa")).toBe(1);
    expect(resolveEditRanges("hello", [{ oldText: "missing", newText: "x" }])).toEqual({
      message: 'oldText not found in file: "missing"',
    });
    expect(resolveEditRanges("repeat repeat", [{ oldText: "repeat", newText: "once" }])).toEqual({
      message: 'oldText is ambiguous (2 matches): "repeat"',
    });
    expect(
      resolveEditRanges("abcdef", [
        { oldText: "abc", newText: "x" },
        { oldText: "bcd", newText: "y" },
      ]),
    ).toEqual({ message: "edits target overlapping regions" });
  });
});

describe("core read policy", () => {
  it("formats content with one-based line numbers", () => {
    expect(formatWithLineNumbers("a\nb")).toBe("1|a\n2|b");
  });

  it("truncates large unicode content without exceeding the byte budget", () => {
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
    const content = `${"a".repeat(MAX_READ_BYTES - markerBytes - 4)}🙂${"b".repeat(
      markerBytes + 1,
    )}`;
    const truncated = truncateForRead(content);

    expect(truncated.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(truncated).toContain("🙂");
  });
});

describe("core bash timing", () => {
  it("normalizes requested timeouts to the supported one-to-600 second range", () => {
    expect(resolveBashTimeoutSeconds(undefined)).toBe(120);
    expect(resolveBashTimeoutSeconds(-10)).toBe(1);
    expect(resolveBashTimeoutSeconds(999)).toBe(600);
    expect(resolveBashTimeoutSeconds(4.9)).toBe(4);
  });

  it("subtracts elapsed provisioning time from the child command budget", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    try {
      const startedAtMs = new Date("2026-01-01T00:00:07.000Z").getTime();
      expect(remainingBashTimeoutSeconds(10, startedAtMs)).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });
});
