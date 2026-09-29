/** AG-UI → dotted CLI events, pinned to the shared golden projector streams. */
import type { AGUIEvent } from "@meridian/contracts/protocol";
import {
  GOLDEN_TOOL_ASSISTANT_TURN_ID,
  GOLDEN_TOOL_CALL_ID,
  SIMPLE_TEXT_TURN_AGUI,
  SIMPLE_TOOL_TURN_AGUI,
} from "@meridian/contracts/threads";
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

  it("assembles streamed tool args and pairs them with the result", () => {
    const events = mapAll(SIMPLE_TOOL_TURN_AGUI);
    const completed = events.find((event) => event.type === "tool.completed");
    expect(completed).toMatchObject({
      type: "tool.completed",
      toolCallId: GOLDEN_TOOL_CALL_ID,
      name: "read_file",
      args: '{"path":"/tmp/x"}',
      result: "file contents",
    });
    expect(events.find((event) => event.type === "turn.finished")).toMatchObject({
      turnId: GOLDEN_TOOL_ASSISTANT_TURN_ID,
    });
    expect(renderEventLine(completed as CliEvent, false)).toBe(
      'tool.completed read_file({"path":"/tmp/x"}) -> file contents',
    );
  });

  it("maps interrupts, run errors, and tool errors", () => {
    const events = mapAll([
      {
        type: "CUSTOM",
        name: "meridian.interrupt",
        value: { turnId: "t1", interruptId: "i1", state: "created" },
      } as AGUIEvent,
      {
        type: "CUSTOM",
        name: "meridian.tool.result_error",
        value: { toolCallId: "c1", isError: true },
      } as AGUIEvent,
      { type: "RUN_ERROR", message: "This response failed." } as AGUIEvent,
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "interrupt.requested",
      "tool.errored",
      "turn.failed",
    ]);
  });

  it("shows the diagnostic failure reason carried by a run error", () => {
    const mapper = new RunEventMapper();
    const [failed] = mapper.map({
      seq: "1",
      event: { type: "RUN_ERROR", message: "This response failed." } as AGUIEvent,
      error: {
        code: "runtime_error",
        message: "This response failed.",
        source: "system",
        retryable: false,
        details: { reason: "orphaned" },
      },
    });

    expect(failed && renderEventLine(failed, false)).toBe(
      "turn.failed This response failed. (failure reason: orphaned)",
    );
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

  it("hides deltas and unknown custom events from text output", () => {
    expect(
      renderEventLine({ type: "message.delta", seq: "1", messageId: "m", text: "x" }, false),
    ).toBeNull();
    expect(renderEventLine({ type: "event", seq: "1", name: "meridian.usage" }, false)).toBeNull();
  });
});
