import { describe, expect, it } from "vitest";

import {
  appendAtReferenceHint,
  COMPOSE_PLACEHOLDERS,
  INTERJECT_PLACEHOLDERS,
  selectNextPlaceholder,
} from "./placeholders";

describe("selectNextPlaceholder", () => {
  it("starts at the first entry and advances through the pool", () => {
    expect(selectNextPlaceholder(COMPOSE_PLACEHOLDERS, null)).toEqual({
      index: 0,
      value: "Chat away",
    });
    expect(selectNextPlaceholder(COMPOSE_PLACEHOLDERS, "0")).toEqual({
      index: 1,
      value: "Write away",
    });
  });

  it("wraps each pool after its last entry", () => {
    expect(
      selectNextPlaceholder(COMPOSE_PLACEHOLDERS, String(COMPOSE_PLACEHOLDERS.length - 1)),
    ).toEqual({ index: 0, value: "Chat away" });
    expect(
      selectNextPlaceholder(INTERJECT_PLACEHOLDERS, String(INTERJECT_PLACEHOLDERS.length - 1)),
    ).toEqual({ index: 0, value: "Interject" });
  });

  it("recovers from an invalid stored index", () => {
    expect(selectNextPlaceholder(COMPOSE_PLACEHOLDERS, "not-a-number")).toEqual({
      index: 0,
      value: "Chat away",
    });
  });

  it("rejects an empty pool", () => {
    expect(() => selectNextPlaceholder([], null)).toThrow("Placeholder pools must not be empty");
  });
});

describe("appendAtReferenceHint", () => {
  const now = Date.UTC(2026, 6, 24);

  it("keeps the dormant mention hint gated off", () => {
    expect(appendAtReferenceHint("Write away", null, false, now)).toBe("Write away");
  });

  it("can append the hint for a missing or stale last-use timestamp", () => {
    expect(appendAtReferenceHint("Write away", null, true, now)).toBe(
      "Write away, @ for reference",
    );
    expect(appendAtReferenceHint("Write away", now - 8 * 24 * 60 * 60 * 1000, true, now)).toBe(
      "Write away, @ for reference",
    );
    expect(appendAtReferenceHint("Write away", now - 6 * 24 * 60 * 60 * 1000, true, now)).toBe(
      "Write away",
    );
  });
});
