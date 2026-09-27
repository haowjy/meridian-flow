import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { clearTraceEvents, getTraceSnapshot } from "../debug/trace/trace-store";
import { buildTranscriptModel } from "./transcript-model";

describe("persisted chat contract diagnostics", () => {
  it("records malformed saved cards and subagent updates in the debug trace", () => {
    clearTraceEvents();
    const turns = [
      {
        id: "assistant-turn",
        role: "assistant",
        blocks: [
          {
            id: "bad-card",
            blockType: "custom",
            content: { kind: "helper-result", props: { status: "completed" } },
          },
        ],
      },
      {
        id: "bad-update",
        role: "system",
        metadata: {
          kind: "subagent_update",
          handle: "p1",
          outcome: "succeeded",
          execution: null,
        },
      },
    ] as unknown as Turn[];

    buildTranscriptModel(turns, false);

    expect(
      getTraceSnapshot()
        .entries.map((event) => event.payload.field)
        .sort(),
    ).toEqual(["invocation_card", "subagent_update"]);
    clearTraceEvents();
  });
});
