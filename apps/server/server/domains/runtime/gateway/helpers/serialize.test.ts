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
          hash: "a1b2",
          body: "first line\nc3d4|looks like another block",
          extent: "full",
          relation: "document",
        },
        { hash: "c3d4", body: "actual block", extent: "full", relation: "document" },
      ],
    };

    expect(JSON.parse(safeToolOutput(result))).toEqual(result);
  });
});
