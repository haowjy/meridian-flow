import { describe, expect, it } from "vitest";
import { assistant, system, toolResult, user } from "../gateway/helpers/messages.js";
import type { Message } from "../gateway/index.js";
import { applyPromptCacheMarks } from "./prompt-cache-marks.js";

function markedIndexes(messages: Message[]): number[] {
  return messages.flatMap((message, index) =>
    message.content.some((part) => part.cacheBreakpoint) ? [index] : [],
  );
}

describe("applyPromptCacheMarks", () => {
  it("is a no-op on an empty request", () => {
    expect(applyPromptCacheMarks([])).toEqual([]);
  });

  it("marks the sole message once when the system message is also the tail", () => {
    const marked = applyPromptCacheMarks([system("You are Writer.")]);
    expect(markedIndexes(marked)).toEqual([0]);
    expect(marked[0].content[0].cacheBreakpoint).toBe(true);
  });

  it("marks only the system message and the tail on a fresh thread's first request", () => {
    const marked = applyPromptCacheMarks([system("You are Writer."), user("Hello.")]);
    expect(markedIndexes(marked)).toEqual([0, 1]);
  });

  it("does not mutate the input messages or their content parts", () => {
    const original = [system("You are Writer."), user("Hello.")];
    const snapshot = JSON.parse(JSON.stringify(original));
    applyPromptCacheMarks(original);
    expect(original).toEqual(snapshot);
  });

  it("marks the read point on the previous request's tail across a tool round-trip", () => {
    // Simulates going from request N (tail = the user message) to request
    // N+1, which appended an assistant tool_use + a tool result.
    const messages = [
      system("You are Writer."),
      user("Continue the scene."),
      assistant([{ type: "tool_use", toolCallId: "call_1", toolName: "search", input: {} }]),
      toolResult("call_1", { ok: true }),
    ];
    const marked = applyPromptCacheMarks(messages);
    // system (0), read point = the previous tail (1), tail (3). The
    // assistant tool_use message (2) is never marked.
    expect(markedIndexes(marked)).toEqual([0, 1, 3]);
  });

  it("lands the read point on the previous request's own tail across two consecutive requests", () => {
    // Request N: the assistant hasn't responded yet, so the tail is the
    // writer's message itself.
    const requestN = [system("You are Writer."), user("Continue the scene.")];
    const markedN = applyPromptCacheMarks(requestN);
    const tailIndexN = markedN.length - 1;
    expect(markedN[tailIndexN].content.at(-1)?.cacheBreakpoint).toBe(true);

    // Request N+1: the loop appended the assistant's tool_use response and
    // the dispatched tool's result on top of request N's own messages.
    const requestNPlus1 = [
      ...requestN,
      assistant([{ type: "tool_use", toolCallId: "call_1", toolName: "search", input: {} }]),
      toolResult("call_1", { ok: true }),
    ];
    const markedNPlus1 = applyPromptCacheMarks(requestNPlus1);

    // The read point in N+1 is exactly the position that was request N's own
    // tail -- the read point of a new request lands on the previous
    // request's tail.
    expect(markedNPlus1[tailIndexN].content.at(-1)?.cacheBreakpoint).toBe(true);
  });

  it("still finds a sensible read point when a steer lands alongside a tool result", () => {
    const messages = [
      system("You are Writer."),
      user("Continue the scene."),
      assistant([{ type: "tool_use", toolCallId: "call_1", toolName: "search", input: {} }]),
      toolResult("call_1", { ok: true }),
      user("Also tighten the pacing."),
    ];
    const marked = applyPromptCacheMarks(messages);
    // Never more than 3 marks, system is always one of them, and the tail is
    // always the actual last message.
    const indexes = markedIndexes(marked);
    expect(indexes.length).toBeLessThanOrEqual(3);
    expect(indexes).toContain(0);
    expect(indexes).toContain(4);
  });

  it("never marks more than three positions on a long history", () => {
    const messages = [
      system("You are Writer."),
      user("Turn 1."),
      assistant([{ type: "text", text: "Reply 1." }]),
      user("Turn 2."),
      assistant([{ type: "text", text: "Reply 2." }]),
      user("Turn 3."),
    ];
    const marked = applyPromptCacheMarks(messages);
    expect(markedIndexes(marked).length).toBeLessThanOrEqual(3);
    // Tail is always marked, and it is always the literal last message.
    expect(marked.at(-1)?.content.at(-1)?.cacheBreakpoint).toBe(true);
  });

  it("never marks an assistant message as the read point", () => {
    const messages = [
      system("You are Writer."),
      assistant([{ type: "text", text: "Reply." }]),
      user("Turn 2."),
    ];
    const marked = applyPromptCacheMarks(messages);
    expect(marked[1].content[0].cacheBreakpoint).toBeUndefined();
  });
});
