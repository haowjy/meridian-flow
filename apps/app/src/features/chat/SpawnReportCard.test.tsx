// @vitest-environment jsdom

import type { Block, JsonValue } from "@meridian/contracts/protocol";
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

function protocolBlock(
  id: string,
  sequence: number,
  blockType: Block["blockType"],
  content: JsonValue,
): Block {
  return {
    id,
    turnId: "parent-turn",
    responseId: null,
    blockType,
    sequence,
    content,
    status: "complete",
    textContent: null,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
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

  it("keeps a background invocation status-only", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard agentName="Critic" title={null} status="completed" childThreadId={null} />,
      ),
    );

    expect(document.querySelector("a[href='scratch://outline.md']")).toBeNull();
    expect(document.body.textContent).toContain("Done");
  });

  it("shows foreground settlement collapsed to its first line and expands the full result", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          agentName="Critic"
          title={null}
          status="failed"
          outcome="failed"
          childThreadId="child-4"
          directResult={{
            execution: "execution-4",
            outcome: "failed",
            summary: "Partial first line.\nLater detail.",
            payload: { retained: true },
            artifacts: [],
            partial: true,
            message: "Child run failed",
            reason: "budget_exhausted",
          }}
        />,
      ),
    );

    expect(document.body.textContent).toContain("Failed");
    expect(document.body.textContent).toContain("Partial first line.");
    expect(document.body.textContent).not.toContain("Later detail.");
    await act(async () => findButton("Show full result")?.click());
    expect(document.body.textContent).toContain("Later detail.");
    expect(document.body.textContent).toContain("budget_exhausted");
    expect(document.body.textContent).toContain("Partial result");
  });

  it("states no partial report output for the actual saved failed direct envelope", async () => {
    const execution = "37403943-a736-4d52-a22b-9665ad7a77e3";
    const callId = "call_00_SjgG2Pag5WxrRl76aW3X5791";
    const use = protocolBlock("use", 0, "tool_use", {
      toolCallId: callId,
      toolName: "spawn",
      output: null,
    });
    const card = protocolBlock("card", 1, "custom", {
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
    const result = protocolBlock("result", 2, "tool_result", {
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

  it("keeps natural empty success distinct from failed empty output", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          agentName="Subagent"
          title={null}
          status="completed"
          outcome="succeeded"
          childThreadId={null}
          directResult={{
            execution: "execution-empty",
            outcome: "succeeded",
            summary: "",
            artifacts: [],
            partial: false,
            message: null,
            reason: null,
          }}
        />,
      ),
    );
    expect(host.textContent).toContain("No report text was returned");
    expect(host.textContent).not.toContain("No partial report text was returned");
  });

  it("keeps an empty cancelled result stopped without suggesting partial output", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          agentName="Subagent"
          title={null}
          status="failed"
          outcome="cancelled"
          childThreadId={null}
          directResult={{
            execution: "execution-cancelled",
            outcome: "cancelled",
            summary: "",
            artifacts: [],
            partial: true,
            message: "Child run was cancelled",
            reason: "cancelled",
          }}
        />,
      ),
    );
    expect(host.textContent).toContain("Stopped");
    expect(host.textContent).toContain("No partial report text was returned");
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

  it("renders a running card while the child is still working", async () => {
    await act(async () =>
      root.render(
        <ChatThreadNavigationProvider onOpenThread={vi.fn()}>
          <SpawnReportCard
            agentName="Critic"
            title="Review the chapter"
            status="running"
            childThreadId="child-3"
          />
        </ChatThreadNavigationProvider>,
      ),
    );

    expect(document.body.textContent).toContain("Critic");
    expect(document.body.textContent).toContain("Review the chapter");
    expect(findButton("Open")).toBeDefined();
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
