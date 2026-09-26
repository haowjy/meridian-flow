// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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

function findButton(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
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
        <ChatThreadNavigationProvider onOpenThread={openThread}>
          <SpawnReportCard
            agentName="Critic"
            title={null}
            status="completed"
            childThreadId="child-1"
          />
        </ChatThreadNavigationProvider>,
      ),
    );

    await act(async () => findButton("Open")?.click());
    expect(openThread).toHaveBeenCalledWith("child-1");
  });

  it("degrades Open to inert text outside a provider", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          agentName="Helper"
          title={null}
          status="completed"
          childThreadId="child-2"
        />,
      ),
    );

    expect(document.querySelector("button")).toBeNull();
    expect(document.body.textContent).toContain("Open");
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
          agentName="Subagent"
          title={null}
          status="failed"
          outcome="failed"
          childThreadId="child-32"
          directResult={directResult}
        />,
      ),
    );
    expect(host.textContent).toContain("Failed");
    expect(host.textContent).toContain("Child run failed");
    expect(host.textContent).toContain("No partial report text was returned");
    expect(host.textContent).not.toContain("runtime_error");
    expect(host.textContent).not.toContain("Partial result");
    expect(findButton("Show full result")).toBeUndefined();
  });

  it("shows cancellation as Stopped", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          agentName="Critic"
          title={null}
          status="failed"
          outcome="cancelled"
          childThreadId={null}
        />,
      ),
    );
    expect(document.body.textContent).toContain("Stopped");
    expect(document.body.textContent).not.toContain("Failed");
  });

  it.each([
    ["succeeded", "Done"],
    ["failed", "Failed"],
    ["cancelled", "Stopped"],
  ] as const)("shows settled direct %s truth while the retained card is running", async (outcome, label) => {
    await act(async () =>
      root.render(
        <SpawnReportCard
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
    expect(host.textContent).toContain(label);
    expect(host.textContent).toContain("Saved result");
    expect(host.textContent).not.toContain("Running");
  });

  it("shows direct unavailable evidence without claiming a terminal outcome, then yields to recovery", async () => {
    const base = { agentName: "Critic", title: null, childThreadId: "child-3" };
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
    expect(host.textContent).toContain("Child report is unavailable");
    expect(host.textContent).not.toContain("Running");
    expect(host.textContent).not.toContain("Failed");
    expect(findButton("Show full result")).toBeUndefined();
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
    expect(host.textContent).toContain("Done");
    expect(host.textContent).not.toContain("Child report is unavailable");
  });

  it("hides the door when no child thread exists", async () => {
    await act(async () =>
      root.render(
        <ChatThreadNavigationProvider onOpenThread={vi.fn()}>
          <SpawnReportCard agentName="Critic" title={null} status="failed" childThreadId={null} />
        </ChatThreadNavigationProvider>,
      ),
    );

    expect(document.querySelector("button")).toBeNull();
    expect(document.body.textContent).not.toContain("Open");
  });
});
