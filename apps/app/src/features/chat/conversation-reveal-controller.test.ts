import { describe, expect, it } from "vitest";
import { conversationRevealController } from "./conversation-reveal-controller";

describe("conversation subagent block reveal", () => {
  it("carries the block identity through thread and turn landing", () => {
    conversationRevealController.cancel();
    conversationRevealController.request({
      kind: "turn",
      threadId: "parent",
      turnId: "turn-2",
      subagentThreadId: "child-5",
    });
    conversationRevealController.snapshot().thread?.landed();
    expect(conversationRevealController.snapshot().turn).toMatchObject({
      threadId: "parent",
      turnId: "turn-2",
      subagentThreadId: "child-5",
    });
    conversationRevealController.cancel();
  });
});

describe("conversation tool call reveal", () => {
  it("carries the tool call through thread landing to the turn stage", () => {
    conversationRevealController.cancel();
    conversationRevealController.request({
      kind: "turn",
      threadId: "chat",
      turnId: "turn-2",
      toolCallId: "call-7",
    });
    conversationRevealController.snapshot().thread?.landed();
    expect(conversationRevealController.snapshot().turn).toMatchObject({
      turnId: "turn-2",
      toolCallId: "call-7",
    });
    conversationRevealController.cancel();
  });
});
