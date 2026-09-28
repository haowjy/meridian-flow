// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/client/api/execution-reports-api", () => ({
  getThreadExecutionReport: vi.fn(async () => ({
    childThreadId: "child-1",
    ref: "p1",
    run: 1,
    outcome: "succeeded",
    deliveryMode: "background_notification",
    source: "return_result",
    summary: "A lantern swims through night.\nThe river keeps its silver name.",
    payload: { stanza: 2 },
    artifacts: [],
    partial: false,
    reason: null,
  })),
}));
// The source is listed live in the project, so its door reads no transcript.
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [{ id: "source-1", title: null }] }),
}));
vi.mock("@/features/project/context/open-project-document", () => ({
  useProjectDocumentNavigationProjectId: () => "project",
}));

import { getThreadExecutionReport } from "@/client/api/execution-reports-api";
import { HelperResultBlock } from "./HelperResultBlock";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actGlobal.IS_REACT_ACT_ENVIRONMENT = true;

describe("HelperResultBlock saved report", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("reads the saved report only when a finished background card is expanded", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <HelperResultBlock
            content={{
              kind: "helper-result",
              props: {
                agentSlug: "poet",
                agentName: "Poet",
                parentTurnId: "parent-turn",
                toolCallId: "spawn-1",
                deliveryMode: "background_notification",
                childThreadId: "child-1",
                execution: "run-1",
                startedAt: "2026-01-01T00:00:00.000Z",
                terminalAt: "2026-01-01T00:01:00.000Z",
                outcome: "succeeded",
              },
            }}
            threadId="parent-1"
            respond={() => undefined}
            retry={() => undefined}
            isAwaitingResponse={false}
            responseState={null}
          />
        </QueryClientProvider>,
      ),
    );
    expect(host.textContent).toContain("Poet");
    expect(host.textContent).not.toContain("A lantern swims through night.");
    expect(getThreadExecutionReport).not.toHaveBeenCalled();
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    await act(async () => undefined);
    expect(getThreadExecutionReport).toHaveBeenCalledWith({
      threadId: "parent-1",
      childThreadId: "child-1",
      execution: "run-1",
    });
    await vi.waitFor(() => expect(host.textContent).toContain("A lantern swims through night."));
  });

  it("names the spawn's from source from the card's own props, as a reload's snapshot has them", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <HelperResultBlock
            content={{
              kind: "helper-result",
              props: {
                agentSlug: "critic",
                agentName: "Critic",
                parentTurnId: "parent-turn",
                toolCallId: "spawn-2",
                deliveryMode: "direct",
                childThreadId: "child-2",
                execution: null,
                startedAt: "2026-01-01T00:00:00.000Z",
                terminalAt: null,
                fromThreadId: "source-1",
                fromThreadRef: "c7",
                fromThreadTitle: "Chapter 12 plan",
              },
            }}
            threadId="parent-1"
            respond={() => undefined}
            retry={() => undefined}
            isAwaitingResponse={false}
            responseState={null}
          />
        </QueryClientProvider>,
      ),
    );
    const line = host.querySelector("[data-spawn-source]");
    expect(line?.getAttribute("data-spawn-source")).toBe("source-1");
    expect(line?.textContent).toBe("From Chapter 12 plan");
    expect(host.textContent).not.toContain("c7");
  });
});
