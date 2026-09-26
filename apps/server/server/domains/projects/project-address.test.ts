/** Project handles are readable, owner-scoped, and reserved across soft deletion. */
import { describe, expect, it } from "vitest";
import { nextProjectSlug } from "./adapters/project-repository/shared.js";

describe("project addresses", () => {
  it("bounds the base and finds the first free numeric suffix in dense reservations", () => {
    const base = "a".repeat(80);
    const reserved = [base, ...Array.from({ length: 1000 }, (_, index) => `${base}-${index + 2}`)];
    expect(nextProjectSlug("a".repeat(200), reserved)).toBe(`${base}-1002`);
    expect(nextProjectSlug("Éowyn", [])).toBe("eowyn");
    expect(nextProjectSlug("!!!", [])).toBe("project");
  });
});
