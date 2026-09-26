// @vitest-environment jsdom
/**
 * The strip is one per-thread surface over the viewed thread's direct children:
 * expandable live rows and a door into each child. Empty
 * subtree renders nothing.
 */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import type { ThreadActivityNode, ThreadStatus } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatThreadNavigationProvider } from "./ChatThreadNavigation";
import { RunningSubagentsStrip } from "./RunningSubagentsStrip";

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
    deliveryMode: null,
    runStartedAt: null,
    runEndedAt: null,
    currentTool: null,
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
    await act(async () => root.render(<RunningSubagentsStrip descendants={[]} />));
    expect(host.textContent?.trim()).toBe("");
  });

  it("renders direct-child rows and opens the clicked child", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        <ChatThreadNavigationProvider onOpenThread={openThread}>
          <RunningSubagentsStrip
            descendants={[
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
            ]}
          />
        </ChatThreadNavigationProvider>,
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
      [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Open subagent chat"]')]
        .at(-1)
        ?.click(),
    );
    expect(openThread).toHaveBeenCalledWith("child-b");
  });

  it("omits the door outside a navigation provider", async () => {
    await act(async () =>
      root.render(
        <RunningSubagentsStrip
          descendants={[node({ threadId: "child-a", agentName: "Critic" })]}
        />,
      ),
    );

    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click(),
    );
    expect(host.querySelector('[aria-label="Open subagent chat"]')).toBeNull();
    expect(host.textContent).toContain("Critic");
  });
});
