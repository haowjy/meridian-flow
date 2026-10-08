/** AG-UI → dotted CLI events, pinned to the shared golden projector streams. */
import type { AGUIEvent } from "@meridian/contracts/protocol";
import { SIMPLE_TEXT_TURN_AGUI } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { type CliEvent, RunEventMapper, renderEventLine } from "./events-map";

function mapAll(events: AGUIEvent[]): CliEvent[] {
  const mapper = new RunEventMapper();
  return events.flatMap((event, index) => mapper.map({ seq: String(index + 1), event }));
}

describe("RunEventMapper", () => {
  it("folds a text turn into started, deltas, one completed message, finished", () => {
    const events = mapAll(SIMPLE_TEXT_TURN_AGUI);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("turn.started");
    expect(types.at(-1)).toBe("turn.finished");
    const completed = events.filter((event) => event.type === "message.completed");
    expect(completed).toHaveLength(1);
    const deltas = events
      .filter((event) => event.type === "message.delta")
      .map((event) => (event.type === "message.delta" ? event.text : ""))
      .join("");
    expect(completed[0]?.type === "message.completed" && completed[0].text).toBe(deltas);
  });

  it("names the call on its error and on its settled result", () => {
    const events = mapAll([
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "write" } as AGUIEvent,
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"command":"insert"}' } as AGUIEvent,
      { type: "TOOL_CALL_END", toolCallId: "c1" } as AGUIEvent,
      { type: "TOOL_CALL_RESULT", toolCallId: "c1", content: "status: success" } as AGUIEvent,
      // A staged write's receipt settles at the end of the reply and replaces its result.
      { type: "TOOL_CALL_RESULT", toolCallId: "c1", content: "status: settled" } as AGUIEvent,
      {
        type: "CUSTOM",
        name: "meridian.tool.result_error",
        value: { toolCallId: "c1", isError: true },
      } as AGUIEvent,
    ]);
    expect(events.slice(1)).toMatchObject([
      { type: "tool.completed", name: "write", args: '{"command":"insert"}' },
      {
        type: "tool.completed",
        name: "write",
        args: '{"command":"insert"}',
        result: "status: settled",
        settled: true,
      },
      { type: "tool.errored", toolCallId: "c1", name: "write" },
    ]);
  });

  it("marks a message joined mid-stream as partial instead of passing a fragment off as whole", () => {
    const events = mapAll([
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: " there" } as AGUIEvent,
      { type: "TEXT_MESSAGE_END", messageId: "m1" } as AGUIEvent,
    ]);
    const completed = events.at(-1);
    expect(completed).toMatchObject({ type: "message.completed", text: " there", partial: true });
    expect(completed && renderEventLine(completed, false)).toBe("assistant (partial): there");
  });
});
