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
import type { DirectInvocationResult } from "./invocation-direct-result";
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
            message: "budget_exhausted",
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
