import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings[0], message: strings[0] }),
}));

import {
  COMPOSE_PLACEHOLDERS,
  INTERJECT_PLACEHOLDERS,
  selectNextPlaceholder,
} from "./placeholders";

describe("selectNextPlaceholder", () => {
  it("starts at the first entry and advances through the pool", () => {
    expect(selectNextPlaceholder(COMPOSE_PLACEHOLDERS, null)).toEqual({
      index: 0,
      value: COMPOSE_PLACEHOLDERS[0],
    });
    expect(selectNextPlaceholder(COMPOSE_PLACEHOLDERS, "0")).toEqual({
      index: 1,
      value: COMPOSE_PLACEHOLDERS[1],
    });
  });

  it("wraps each pool after its last entry", () => {
    expect(
      selectNextPlaceholder(COMPOSE_PLACEHOLDERS, String(COMPOSE_PLACEHOLDERS.length - 1)),
    ).toEqual({ index: 0, value: COMPOSE_PLACEHOLDERS[0] });
    expect(
      selectNextPlaceholder(INTERJECT_PLACEHOLDERS, String(INTERJECT_PLACEHOLDERS.length - 1)),
    ).toEqual({ index: 0, value: INTERJECT_PLACEHOLDERS[0] });
  });

  it("recovers from an invalid stored index", () => {
    expect(selectNextPlaceholder(COMPOSE_PLACEHOLDERS, "not-a-number")).toEqual({
      index: 0,
      value: COMPOSE_PLACEHOLDERS[0],
    });
  });

  it("rejects an empty pool", () => {
    expect(() => selectNextPlaceholder([], null)).toThrow("Placeholder pools must not be empty");
  });

  it("uses typographic ellipses for interjection prompts", () => {
    expect(INTERJECT_PLACEHOLDERS[2].message).toBe("Actually…");
    expect(INTERJECT_PLACEHOLDERS[3].message).toBe("Hold on…");
  });
});
