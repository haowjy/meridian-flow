/**
 * Projector wire contracts: the client-facing custom event names and payloads
 * for durable block lifecycle facts. Pins the names the app reducer reads.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { projectOrchestratorEvents } from "./orchestrator-event-projector.js";

describe("orchestrator event projector", () => {
  it("maps a pruned block to the client prune frame", () => {
    const events = projectOrchestratorEvents([{ type: "block.pruned", blockId: "block-1" }]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "meridian.block.pruned",
      value: { blockId: "block-1" },
    });
  });
});
