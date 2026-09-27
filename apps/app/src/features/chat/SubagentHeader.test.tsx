// @vitest-environment jsdom
/** The subagent popover rows are child-thread navigation doors. */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./conversation-reveal", () => ({ requestConversationReveal: vi.fn() }));

import type { ThreadActivityNode, ThreadStatus } from "@meridian/contracts/threads";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requestConversationReveal } from "./conversation-reveal";
import { SubagentHeader } from "./SubagentHeader";

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

  it("opens a child from the whole row and closes the popover", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SubagentHeader
            threadId="parent"
            nodes={[node({ threadId: "child", agentName: "Critic" })]}
            openThread={openThread}
          />
        </TooltipProvider>,
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());

    const row = document.body.querySelector<HTMLButtonElement>('[aria-label="Open Critic"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    expect(row?.querySelector("svg.lucide-external-link")).toBeNull();
    await act(async () => row?.click());

    expect(openThread).toHaveBeenCalledWith("child");
    expect(document.body.querySelector('[aria-label="Open Critic"]')).toBeNull();
  });

  it("keeps Jump separate and available only for rows with a reveal target", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
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
            openThread={openThread}
          />
        </TooltipProvider>,
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());

    const row = document.body.querySelector<HTMLButtonElement>('[aria-label="Open Researcher"]');
    const jump = document.body.querySelector<HTMLButtonElement>('[aria-label="Jump to in chat"]');
    expect(row).not.toBeNull();
    expect(jump).not.toBeNull();
    expect(row?.closest("li")).toBe(jump?.closest("li"));
    expect(row?.parentElement?.querySelectorAll("button")).toHaveLength(2);
    expect(document.body.querySelector('[aria-label="Open Editor"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[aria-label="Jump to in chat"]')).toHaveLength(1);

    await act(async () => jump?.click());
    expect(openThread).not.toHaveBeenCalled();
    expect(requestConversationReveal).toHaveBeenCalledWith({
      kind: "turn",
      threadId: "parent",
      turnId: "turn-1",
      subagentThreadId: "running",
    });
  });
});
