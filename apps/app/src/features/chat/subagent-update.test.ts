import { describe, expect, it } from "vitest";
import { groupAdjacentSubagentUpdates, readSubagentUpdateMetadata } from "./subagent-update";

describe("subagent update events", () => {
  it("validates the wire metadata once into a typed outcome", () => {
    expect(
      readSubagentUpdateMetadata({
        kind: "subagent_update",
        handle: "p5",
        execution: "x",
        outcome: "cancelled",
      }),
    ).toEqual({
      kind: "subagent_update",
      handle: "p5",
      execution: "x",
      outcome: "cancelled",
    });
    expect(
      readSubagentUpdateMetadata({ kind: "subagent_update", handle: "p5", outcome: "unknown" }),
    ).toBeNull();
  });

  it("groups only adjacent completion notices", () => {
    const update = readSubagentUpdateMetadata({
      kind: "subagent_update",
      handle: "p1",
      outcome: "succeeded",
    });
    const events = [
      { id: "a", subagentUpdate: update },
      { id: "b", subagentUpdate: update },
      { id: "message", subagentUpdate: null },
      { id: "c", subagentUpdate: update },
    ];
    expect(
      groupAdjacentSubagentUpdates(events).map((group) => group.map((event) => event.id)),
    ).toEqual([["a", "b"], ["message"], ["c"]]);
  });
});
