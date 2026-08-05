// Provider serialization contract for structured tool results.
import { describe, expect, it } from "vitest";
import { safeToolOutput } from "./serialize.js";

describe("safeToolOutput", () => {
  it("serializes every array uniformly instead of guessing a content protocol", () => {
    const result = [{ type: "text", text: "structured data" }];

    expect(JSON.parse(safeToolOutput(result))).toEqual(result);
  });
});
