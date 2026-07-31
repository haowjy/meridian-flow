// Provider serialization contract for structured tool results.
import { describe, expect, it } from "vitest";
import { safeToolOutput } from "./serialize.js";

describe("safeToolOutput", () => {
  it("JSON-serializes the agent-edit envelope without flattening block boundaries", () => {
    const result = {
      schema: "meridian.agent-edit.v1",
      command: "read",
      status: "success",
      blocks: [
        {
          extent: "full",
          relation: "document",
          items: [
            { hash: "a1b2", body: "first line\nc3d4|looks like another block" },
            { hash: "c3d4", body: "actual block" },
          ],
        },
      ],
    };

    expect(JSON.parse(safeToolOutput(result))).toEqual(result);
  });

  it("serializes every array uniformly instead of guessing a content protocol", () => {
    const result = [{ type: "text", text: "structured data" }];

    expect(JSON.parse(safeToolOutput(result))).toEqual(result);
  });
});
