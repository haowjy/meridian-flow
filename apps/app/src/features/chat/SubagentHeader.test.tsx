// @vitest-environment jsdom
/** The subagent popover rows are child-thread navigation doors. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./conversation-reveal", () => ({ requestConversationReveal: vi.fn() }));

import type { ThreadActivityNode, ThreadStatus } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { requestConversationReveal } from "./conversation-reveal";
import { SubagentHeader } from "./SubagentHeader";
import { renderChatSurface } from "./subagent/renderChatSurface";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const AWAKE: ThreadStatus = { kind: "awake", phase: "generating", cancelRequested: false };
const ASLEEP: ThreadStatus = { kind: "asleep" };

function node(overrides: Partial<ThreadActivityNode> & { threadId: string }): ThreadActivityNode {
  return {
    parentThreadId: "parent",
    rootThreadId: "parent",
    depth: 1,
    ref: null,
    title: null,
    agentName: null,
    spawnStatus: "running",
    status: AWAKE,
    deliveryMode: null,
    runStartedAt: null,
    runEndedAt: null,
    currentTool: null,
    originTurnId: null,
    ...overrides,
  };
}

describe("SubagentHeader", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("opens a child from its chat icon and closes the popover", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        renderChatSurface(
          <SubagentHeader
            threadId="parent"
            nodes={[node({ threadId: "child", agentName: "Critic" })]}
          />,
          openThread,
        ),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());

    const open = document.body.querySelector<HTMLButtonElement>("[aria-label='Open \"Critic\"']");
    expect(open?.querySelector("svg.lucide-message-square-share")).not.toBeNull();
    expect(document.body.querySelector("svg.lucide-locate-fixed")).toBeNull();
    await act(async () => open?.click());

    expect(openThread).toHaveBeenCalledWith("child");
    expect(document.body.querySelector("[aria-label='Open \"Critic\"']")).toBeNull();
  });

  it("jumps to the subagent in chat from the row when it has a reveal target", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        renderChatSurface(
          <SubagentHeader
            threadId="parent"
            nodes={[
              node({ threadId: "running", agentName: "Researcher", originTurnId: "turn-1" }),
              node({
                threadId: "finished",
                agentName: "Editor",
                status: ASLEEP,
                spawnStatus: "succeeded",
              }),
            ]}
          />,
          openThread,
        ),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());

    const rows = document.body.querySelectorAll<HTMLButtonElement>(
      'button[title="Jump to in chat"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Researcher");
    expect(document.body.querySelector("[aria-label='Open \"Editor\"']")).not.toBeNull();

    await act(async () => rows[0]?.click());
    expect(openThread).not.toHaveBeenCalled();
    expect(requestConversationReveal).toHaveBeenCalledWith({
      kind: "turn",
      threadId: "parent",
      turnId: "turn-1",
      subagentThreadId: "running",
    });
  });
});
