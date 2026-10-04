import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { partitionTurn } from "./partition-turn";
import { block, toolView } from "./report-test-fixtures";
import { countFoldTools } from "./thinking-digest";
import { toolRowFailed } from "./tool-renderers";
import { isToolViewVisible } from "./tool-view-visibility";

const queued = {
  status: "background",
  handle: "p3",
  threadId: "child-1",
  agentSlug: "critic",
  notifiesCaller: true,
};

const foreground = { ref: "p3", message: "Go", mode: "foreground" };

function messageTool({
  result,
  input = { ref: "p3", message: "Tighten the ending." },
  isError = false,
}: {
  result: JsonValue;
  input?: JsonValue;
  isError?: boolean;
}) {
  return toolView({
    toolCallId: "message-1",
    toolName: "thread_message",
    input,
    result,
    isError,
  });
}

/** A foreground call's protocol pair, with the helper card when the child run started. */
function foregroundTurn(result: JsonValue, { withCard }: { withCard: boolean }): Block[] {
  const blocks = [
    block("use", 1, "tool_use", {
      toolCallId: "message-1",
      toolName: "thread_message",
      input: foreground,
    }),
    block("result", 3, "tool_result", {
      toolCallId: "message-1",
      output: "Child thread already has an active run (thread_message_target_busy)",
      result,
      isError: true,
    }),
  ];
  if (!withCard) return blocks;
  const card = block("card", 2, "custom", {
    kind: "helper-result",
    props: {
      agentSlug: "critic",
      agentName: "Critic",
      parentTurnId: "parent-turn",
      toolCallId: "message-1",
      deliveryMode: "direct",
      startedAt: "2026-09-23T00:00:00.000Z",
      terminalAt: "2026-09-23T00:00:01.000Z",
      reason: "Child thread already has an active run",
    },
  });
  return [blocks[0] as Block, card, blocks[1] as Block];
}

describe("thread_message presentation", () => {
  it("shows a queued message as a fold step", () => {
    const tool = messageTool({ result: queued });
    expect(isToolViewVisible(tool)).toBe(true);
    expect(toolRowFailed(tool)).toBe(false);
    // The fold digest counts exactly the rows it shows.
    expect(countFoldTools([tool]).steps).toBe(1);
  });

  it("says when a foreground message was refused before it started", () => {
    // Turn budget, no agent binding, not authorised: no child run, so no card.
    const refused = {
      status: "error",
      error: { code: "thread_message_not_authorized", message: "Not authorised" },
    };
    const tool = messageTool({ result: refused, input: foreground, isError: true });
    expect(isToolViewVisible(tool)).toBe(true);
    expect(toolRowFailed(tool)).toBe(true);

    const items = partitionTurn(foregroundTurn(refused, { withCard: false }));
    expect(items.map((item) => item.kind)).toEqual(["process"]);
  });

  it("leaves a failed foreground message with a card to the card alone", () => {
    // A busy target: the child's card became a failure card that names the reason.
    const busy = {
      status: "error",
      error: { code: "thread_message_target_busy", message: "Busy" },
    };
    const items = partitionTurn(foregroundTurn(busy, { withCard: true }));
    expect(items.map((item) => item.kind)).toEqual(["artifact"]);
    expect(items[0]).toMatchObject({ block: { id: "card" } });
  });
});
