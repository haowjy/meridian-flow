import { describe, expect, it } from "vitest";

import { safeToolOutput } from "../serialize.js";

describe("safeToolOutput", () => {
  it("preserves empty string output as a non-empty JSON string literal", () => {
    expect(safeToolOutput("")).toBe('""');
  });

  it("preserves nullish output as null", () => {
    expect(safeToolOutput(null)).toBe("null");
    expect(safeToolOutput(undefined)).toBe("null");
  });

  it("serializes objects and arrays as JSON", () => {
    expect(safeToolOutput({ ok: true })).toBe('{"ok":true}');
    expect(safeToolOutput(["a", 1])).toBe('["a",1]');
  });

  it("falls back to String(output) when JSON serialization fails", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(safeToolOutput(cyclic)).toBe("[object Object]");
  });
});
