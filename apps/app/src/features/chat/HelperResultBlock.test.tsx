// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/api/execution-reports-api", () => ({
  getThreadExecutionReport: vi.fn(async () => ({
    ref: "p1",
    execution: "run-1",
    outcome: "succeeded",
    source: "return_result",
    summary: "A lantern swims through night.\nThe river keeps its silver name.",
    payload: { stanza: 2 },
    artifacts: [],
    partial: false,
    reason: null,
  })),
}));

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

  it("loads a background card's saved report collapsed and expands the full result", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <HelperResultBlock
            content={{
              kind: "helper-result",
              props: {
                agentName: "Poet",
                status: "completed",
                outcome: "succeeded",
                deliveryMode: "background_notification",
                childThreadId: "child-1",
                execution: "run-1",
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
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(host.textContent).toContain("A lantern swims through night.");
    expect(host.textContent).not.toContain("The river keeps its silver name.");
    const toggle = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show full result"),
    );
    expect(toggle).toBeDefined();
    await act(async () => toggle?.click());
    expect(host.textContent).toContain("The river keeps its silver name.");
  });
});
