// @vitest-environment jsdom

import type { Block, JsonValue } from "@meridian/contracts/protocol";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { partitionTurn } from "./partition-turn";
import { block, toolView } from "./report-test-fixtures";
import { SubagentActivityProvider } from "./subagent/ActivityContext";
import { countFoldTools } from "./thinking-digest";
import { THREAD_MESSAGE_RENDERER } from "./thread-message-renderer";
import { toolRowFailed } from "./tool-renderers";
import { isToolViewVisible } from "./tool-view-visibility";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

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
  status,
}: {
  result: JsonValue;
  input?: JsonValue;
  isError?: boolean;
  status?: "partial";
}) {
  const tool = toolView({
    toolCallId: "message-1",
    toolName: "thread_message",
    input,
    result,
    isError,
  });
  return status ? { ...tool, status } : tool;
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

const critic: ThreadActivityNode = {
  threadId: "child-1",
  parentThreadId: "thread-1",
  ref: "p3",
  title: "Review chapter 12",
  agentName: "Critic",
  spawnStatus: "running",
  status: { kind: "awake", phase: "generating", cancelRequested: false },
  runStartedAt: null,
  runEndedAt: null,
  currentTool: null,
  deliveryMode: "background_notification",
  originTurnId: null,
};

function renderTitle(tool: ReturnType<typeof messageTool>): string {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <SubagentActivityProvider nodes={[critic]}>
        {THREAD_MESSAGE_RENDERER.title(tool, { writeMode: "direct" })}
      </SubagentActivityProvider>,
    ),
  );
  return container.textContent ?? "";
}

describe("thread_message presentation", () => {
  it("shows a queued message as a fold step", () => {
    const tool = messageTool({ result: queued });
    expect(isToolViewVisible(tool)).toBe(true);
    expect(toolRowFailed(tool)).toBe(false);
    // The fold digest counts exactly the rows it shows.
    expect(countFoldTools([tool]).steps).toBe(1);
  });

  it("names the subagent the way the other subagent rows do", () => {
    const text = renderTitle(messageTool({ result: queued }));
    expect(text).toBe("Sent a message to CriticReview chapter 12");
    expect(text).not.toContain("p3");
    expect(text).not.toContain("queued");
  });

  it("shows the message the agent sent when expanded", () => {
    const expand = THREAD_MESSAGE_RENDERER.expand?.(messageTool({ result: queued }));
    if (!expand) throw new Error("expected an expandable message");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(expand()));
    expect(container.textContent).toBe("Tighten the ending.");
  });

  it("leaves a foreground re-task that ran to its helper card", () => {
    const report = { status: "completed", outcome: "succeeded", report: { summary: "Done." } };
    expect(isToolViewVisible(messageTool({ result: report, input: foreground }))).toBe(false);
  });

  it("says when a foreground message was refused before it started", () => {
    // Turn budget, no agent binding, not authorised: no child run, so no card.
    const refused = {
      status: "error",
      error: { code: "thread_message_not_authorized", message: "Not authorised" },
    };
    // The refusal is a typed result, saved without `isError`.
    const tool = messageTool({ result: refused, input: foreground });
    expect(isToolViewVisible(tool)).toBe(true);
    expect(toolRowFailed(tool)).toBe(true);
    expect(renderTitle(tool)).toBe("Couldn't send a message to CriticReview chapter 12");

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

  it("stays hidden while the call is in flight", () => {
    expect(isToolViewVisible(messageTool({ result: null, status: "partial" }))).toBe(false);
  });

  it("says when a background message couldn't be sent", () => {
    const failed = messageTool({
      result: { status: "error", error: { message: "Thread not found" } },
    });
    expect(isToolViewVisible(failed)).toBe(true);
    expect(toolRowFailed(failed)).toBe(true);
    expect(renderTitle(failed)).toBe("Couldn't send a message to CriticReview chapter 12");
  });
});
