import { describe, expect, it } from "vitest";

import { compareSeq, parseSeq } from "./event-seq";

describe("event seq", () => {
  it("parses flat decimal seq strings", () => {
    expect(parseSeq("0")).toBe("0");
    expect(parseSeq("42")).toBe("42");
    expect(parseSeq("010")).toBeNull();
    expect(parseSeq("10:1")).toBeNull();
    expect(parseSeq("")).toBeNull();
  });

  it("orders flat decimal seq values", () => {
    expect(compareSeq("9", "10")).toBeLessThan(0);
    expect(compareSeq("10", "9")).toBeGreaterThan(0);
    expect(compareSeq("42", "42")).toBe(0);
  });
});
