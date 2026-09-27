// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatThreadNavigationProvider } from "./ChatThreadNavigation";
import { type DirectInvocationResult, directResultsForTurn } from "./invocation-direct-result";
import { block } from "./report-test-fixtures";
import { SpawnReportCard } from "./SpawnReportCard";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function findToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("button[aria-expanded]");
}

function findButton(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name || button.getAttribute("aria-label") === name,
  ) as HTMLButtonElement | undefined;
}

describe("SpawnReportCard", () => {
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

  it("opens the child chat from the report's door", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ChatThreadNavigationProvider onOpenThread={openThread}>
            <SpawnReportCard
              deliveryMode="background_notification"
              agentName="Critic"
              title={null}
              status="completed"
              childThreadId="child-1"
            />
          </ChatThreadNavigationProvider>
        </TooltipProvider>,
      ),
    );

    await act(async () => findButton("Open subagent chat")?.click());
    expect(openThread).toHaveBeenCalledWith("child-1");
  });

  it("shows the persisted p17 result, duration, and expansion control", async () => {
    const callId = "call_00_ViHYdu2IAn05PnxA5aQR1107";
    const use = block("p17-use", 1, "tool_use", {
      toolCallId: callId,
      toolName: "spawn",
      input: { mode: "foreground", description: "Repeat-read comparison" },
      output: null,
      isError: false,
    });
    const card = block("p17-card", 2, "custom", {
      kind: "helper-result",
      props: {
        parentTurnId: "parent-turn",
        toolCallId: callId,
        childThreadId: "dd343f46-16e9-44b5-8196-92c5c243d87d",
        deliveryMode: "direct",
        execution: "0e068ea5-aeb7-41e0-81bc-06ac27e5fde0",
        status: "completed",
        outcome: "succeeded",
        startedAt: "2026-09-26T21:13:52.043Z",
        terminalAt: "2026-09-26T21:14:21.983Z",
      },
    });
    const result = block("p17-result", 3, "tool_result", {
      toolCallId: callId,
      output: {
        report: { handle: "p17", summary: "Read the document 21 times. All reads matched." },
        status: "completed",
        outcome: "succeeded",
      },
    });
    const directResult = directResultsForTurn([use, card, result]).get(card.id);
    expect(directResult).toBeDefined();
    await act(async () =>
      root.render(
        <SpawnReportCard
          agentName="Repeat-read comparison"
          title="Repeat-read comparison"
          status="completed"
          outcome="succeeded"
          deliveryMode="direct"
          startedAt="2026-09-26T21:13:52.043Z"
          terminalAt="2026-09-26T21:14:21.983Z"
          childThreadId="dd343f46-16e9-44b5-8196-92c5c243d87d"
          directResult={directResult}
        />,
      ),
    );

    expect(host.textContent).toContain("29s");
    expect(findToggle()).not.toBeNull();
    await act(async () => findToggle()?.click());
    expect(host.textContent).toContain("Read the document 21 times. All reads matched.");
  });

  it("shows the live tool call on a running background launch, then drops it when done", async () => {
    const base = {
      deliveryMode: "background_notification" as const,
      agentName: "Writer",
      title: "Short story B",
      childThreadId: "child-live",
    };
    await act(async () =>
      root.render(<SpawnReportCard {...base} status="running" liveTool="Writing story-b.md" />),
    );
    expect(host.textContent).toContain("Writing story-b.md");
    await act(async () =>
      root.render(
        <SpawnReportCard {...base} status="completed" outcome="succeeded" liveTool={null} />,
      ),
    );
    expect(host.textContent).not.toContain("Writing story-b.md");
    expect(host.textContent).not.toContain("Working");
  });

  it("degrades Open to inert text outside a provider", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          deliveryMode="background_notification"
          agentName="Helper"
          title={null}
          status="completed"
          childThreadId="child-2"
        />,
      ),
    );

    expect(document.querySelector("button")).toBeNull();
    expect(document.querySelector("button")).toBeNull();
  });

  it("states no partial report output for the actual saved failed direct envelope", async () => {
    const execution = "37403943-a736-4d52-a22b-9665ad7a77e3";
    const callId = "call_00_SjgG2Pag5WxrRl76aW3X5791";
    const use = block("use", 0, "tool_use", {
      toolCallId: callId,
      toolName: "spawn",
      output: null,
    });
    const card = block("card", 1, "custom", {
      kind: "helper-result",
      props: {
        parentTurnId: "parent-turn",
        toolCallId: callId,
        childThreadId: "child-32",
        deliveryMode: "direct",
        execution,
        status: "failed",
        outcome: "failed",
      },
    });
    const result = block("result", 2, "tool_result", {
      toolCallId: callId,
      output: {
        status: "error",
        execution,
        outcome: "failed",
        partial: true,
        reason: "runtime_error",
        error: {
          code: "spawn_failed",
          source: "system",
          message: "Child run failed",
          retryable: false,
        },
        report: { handle: "p13", summary: "" },
      },
    });
    const directResult = directResultsForTurn([use, card, result]).get(card.id);
    expect(directResult).toBeDefined();
    await act(async () =>
      root.render(
        <SpawnReportCard
          deliveryMode="background_notification"
          agentName="Subagent"
          title={null}
          status="failed"
          outcome="failed"
          childThreadId="child-32"
          directResult={directResult}
        />,
      ),
    );
    expect(host.textContent).not.toContain("Child run failed");
    expect(host.textContent).not.toContain("runtime_error");
    expect(host.textContent).not.toContain("Partial result");
  });

  it("shows cancellation as Stopped", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          deliveryMode="background_notification"
          agentName="Critic"
          title={null}
          status="failed"
          outcome="cancelled"
          childThreadId={null}
        />,
      ),
    );
    expect(document.querySelector('[aria-label="Stopped"]')).not.toBeNull();
  });

  it.each([
    "succeeded",
    "failed",
    "cancelled",
  ] as const)("shows settled direct %s truth while the retained card is running", async (outcome) => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          deliveryMode="direct"
          agentName="Critic"
          title={null}
          status="running"
          childThreadId="child-3"
          directResult={{
            execution: "execution-3",
            outcome,
            summary: "Saved result",
            artifacts: [],
            partial: outcome !== "succeeded",
            message: null,
            reason: null,
          }}
        />,
      ),
    );
    const status = outcome === "succeeded" ? "Finished" : "Stopped";
    expect(host.querySelector(`[aria-label="${status}"]`)).not.toBeNull();
    expect(host.textContent).not.toContain("Saved result");
    await act(async () => findToggle()?.click());
    expect(host.textContent).toContain("Saved result");
    expect(host.textContent).not.toContain("Working");
  });

  it("shows direct unavailable evidence without claiming a terminal outcome, then yields to recovery", async () => {
    const base = {
      agentName: "Critic",
      title: null,
      childThreadId: "child-3",
      deliveryMode: "direct" as const,
    };
    const directResult: DirectInvocationResult = {
      execution: "execution-3",
      outcome: null,
      summary: "",
      artifacts: [],
      partial: false,
      message: "Child report is unavailable",
      reason: null,
    };
    await act(async () =>
      root.render(<SpawnReportCard {...base} status="running" directResult={directResult} />),
    );
    expect(host.textContent).toContain("Working");
    expect(host.textContent).not.toContain("Child report is unavailable");
    expect(findToggle()).toBeNull();
    await act(async () =>
      root.render(
        <SpawnReportCard
          {...base}
          status="completed"
          outcome="succeeded"
          directResult={directResult}
        />,
      ),
    );
    expect(host.querySelector('[aria-label="Finished"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Child report is unavailable");
  });

  it("hides the door when no child thread exists", async () => {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ChatThreadNavigationProvider onOpenThread={vi.fn()}>
            <SpawnReportCard
              deliveryMode="background_notification"
              agentName="Critic"
              title={null}
              status="failed"
              childThreadId={null}
            />
          </ChatThreadNavigationProvider>
        </TooltipProvider>,
      ),
    );

    expect(document.querySelector("button")).toBeNull();
    expect(document.body.textContent).not.toContain("Open");
  });
});
