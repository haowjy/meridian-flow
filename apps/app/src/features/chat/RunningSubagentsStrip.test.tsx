// @vitest-environment jsdom
/**
 * The strip is one per-thread surface over the viewed thread's direct children:
 * expandable live rows and a door into each child. Empty
 * subtree renders nothing.
 */

import type { ThreadActivityNode, ThreadStatus } from "@meridian/contracts/threads";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatThreadNavigationProvider } from "./ChatThreadNavigation";
import { RunningSubagentsStrip } from "./RunningSubagentsStrip";
import { SubagentActivityProvider } from "./subagent/ActivityContext";

function withNodes(nodes: ThreadActivityNode[], children: ReactNode) {
  return <SubagentActivityProvider nodes={nodes}>{children}</SubagentActivityProvider>;
}

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const AWAKE: ThreadStatus = { kind: "awake", phase: "generating", cancelRequested: false };

function node(overrides: Partial<ThreadActivityNode> & { threadId: string }): ThreadActivityNode {
  return {
    parentThreadId: "thread-1",
    rootThreadId: "thread-1",
    depth: 1,
    ref: null,
    title: null,
    agentName: null,
    spawnStatus: "running",
    status: AWAKE,
    runStartedAt: null,
    runEndedAt: null,
    currentTool: null,
    deliveryMode: "background_notification",
    originTurnId: null,
    ...overrides,
  };
}

describe("RunningSubagentsStrip", () => {
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

  it("renders nothing when there are no active descendants", async () => {
    await act(async () =>
      root.render(withNodes([], <RunningSubagentsStrip threadId="thread-1" />)),
    );
    expect(host.textContent?.trim()).toBe("");
  });

  it("renders direct-child rows and opens the clicked child", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        withNodes(
          [
            node({ threadId: "child-a", agentName: "Critic", title: "Review the chapter" }),
            node({
              threadId: "child-b",
              agentName: "Reader",
              currentTool: {
                toolCallId: "tool-1",
                toolName: "spawn",
                input: { agent: "Researcher" },
              },
            }),
          ],
          <TooltipProvider>
            <ChatThreadNavigationProvider onOpenThread={openThread}>
              <RunningSubagentsStrip threadId="thread-1" />
            </ChatThreadNavigationProvider>
          </TooltipProvider>,
        ),
      ),
    );

    expect(host.textContent).toContain("2 subagents");
    expect(host.textContent).toContain("2 running");
    expect(host.textContent).not.toContain("Critic");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click(),
    );
    expect(host.textContent).toContain("Critic");
    expect(host.textContent).toContain("Reader");
    expect(host.textContent).toContain("Waiting on Researcher");

    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>("button[aria-label^=Open]")].at(-1)?.click(),
    );
    expect(openThread).toHaveBeenCalledWith("child-b");
  });

  it("marks an agent-less child as Subagent while showing its task title", async () => {
    await act(async () =>
      root.render(
        withNodes(
          [node({ threadId: "child-a", title: "Codex scan" })],
          <RunningSubagentsStrip threadId="thread-1" />,
        ),
      ),
    );

    const mark = host.querySelector<HTMLElement>('[role="img"]');
    expect(mark?.textContent).toBe("S");
    expect(mark?.getAttribute("aria-label")).toBe("Running");
    expect(host.textContent).toContain("Codex scan");
  });

  it("omits the door outside a navigation provider", async () => {
    await act(async () =>
      root.render(
        withNodes(
          [node({ threadId: "child-a", agentName: "Critic" })],
          <RunningSubagentsStrip threadId="thread-1" />,
        ),
      ),
    );

    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click(),
    );
    expect(host.querySelector("button[aria-label^=Open]")).toBeNull();
    expect(host.textContent).toContain("Critic");
  });
});
