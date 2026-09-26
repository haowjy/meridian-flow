// @vitest-environment jsdom
/**
 * The strip lists direct children in flat rows, with live status labels and a
 * door into each child. Empty activity renders nothing.
 */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
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
    ref: null,
    title: null,
    agentName: null,
    spawnStatus: "running",
    status: AWAKE,
    originTurnId: null,
    ...overrides,
  };
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
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

  it("renders nothing when there are no active children", async () => {
    await act(async () =>
      root.render(<RunningSubagentsStrip selfStatus={{ kind: "asleep" }} subagents={[]} />),
    );
    expect(host.textContent?.trim()).toBe("");
  });

  it("renders flat direct-child rows with live status and opens the clicked child", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        <ChatThreadNavigationProvider onOpenThread={openThread}>
          <RunningSubagentsStrip
            selfStatus={{ kind: "asleep" }}
            subagents={[
              node({ threadId: "child-a", agentName: "Critic", title: "Review the chapter" }),
              node({
                threadId: "child-b",
                agentName: "Reader",
                status: { kind: "awake", phase: "waiting", cancelRequested: false },
              }),
            ]}
          />
        </ChatThreadNavigationProvider>,
      ),
    );

    expect(host.textContent).toContain("2 subagents running");
    expect(host.textContent).toContain("Critic");
    expect(host.textContent).toContain("Reader");
    // The viewed thread is asleep while direct children run; one child waits.
    expect(host.textContent).toContain("Asleep");
    expect(host.textContent).toContain("Waiting");

    await act(async () => buttonContaining("Reader")?.click());
    expect(openThread).toHaveBeenCalledWith("child-b");
  });

  it("omits the door outside a navigation provider", async () => {
    await act(async () =>
      root.render(
        <RunningSubagentsStrip
          selfStatus={{ kind: "asleep" }}
          subagents={[node({ threadId: "child-a", agentName: "Critic" })]}
        />,
      ),
    );

    expect(buttonContaining("Critic")).toBeUndefined();
    expect(host.textContent).toContain("Critic");
  });
});
