// @vitest-environment jsdom

import type { JsonValue } from "@meridian/contracts/protocol";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { toolView } from "./report-test-fixtures";
import { SubagentActivityProvider } from "./subagent/ActivityContext";
import { countFoldTools } from "./thinking-digest";
import { THREAD_MESSAGE_RENDERER } from "./thread-message-renderer";
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
  agentSlug: "critic",
  notifiesCaller: true,
  note: "Message queued. You'll be notified when p3 finishes.",
};

function messageTool({
  output,
  input = { ref: "p3", message: "Tighten the ending." },
  isError = false,
  status,
}: {
  output: JsonValue;
  input?: JsonValue;
  isError?: boolean;
  status?: "partial";
}) {
  const tool = toolView({
    toolCallId: "message-1",
    toolName: "thread_message",
    input,
    output,
    isError,
  });
  return status ? { ...tool, status } : tool;
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
    const tool = messageTool({ output: queued });
    expect(isToolViewVisible(tool)).toBe(true);
    // The fold digest counts exactly the rows it shows.
    expect(countFoldTools([tool]).steps).toBe(1);
  });

  it("names the subagent the way the other subagent rows do", () => {
    const text = renderTitle(messageTool({ output: queued }));
    expect(text).toBe("Sent a message to CriticReview chapter 12");
    expect(text).not.toContain("p3");
    expect(text).not.toContain("queued");
  });

  it("shows the message the agent sent when expanded", () => {
    const expand = THREAD_MESSAGE_RENDERER.expand?.(messageTool({ output: queued }));
    if (!expand) throw new Error("expected an expandable message");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(expand()));
    expect(container.textContent).toBe("Tighten the ending.");
  });

  it("leaves a foreground re-task to its helper card", () => {
    const report = { status: "completed", outcome: "succeeded", report: { summary: "Done." } };
    expect(isToolViewVisible(messageTool({ output: report }))).toBe(false);
    const failed = { status: "error", error: { message: "Failed" } };
    const foreground = { ref: "p3", message: "Go", mode: "foreground" };
    expect(isToolViewVisible(messageTool({ output: failed, input: foreground }))).toBe(false);
  });

  it("stays hidden while the call is in flight", () => {
    expect(isToolViewVisible(messageTool({ output: null, status: "partial" }))).toBe(false);
  });

  it("says when a background message couldn't be sent", () => {
    const failed = messageTool({
      output: { status: "error", error: { message: "Thread not found" } },
    });
    expect(isToolViewVisible(failed)).toBe(true);
    expect(renderTitle(failed)).toBe("Couldn't send a message to CriticReview chapter 12");
  });

  it("never reads the model's note", () => {
    const text = renderTitle(messageTool({ output: { ...queued, notifiesCaller: false } }));
    expect(text).not.toContain("Message queued");
  });
});
