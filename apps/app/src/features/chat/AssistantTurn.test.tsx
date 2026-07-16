// @vitest-environment jsdom

import type { Turn } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeTrailShell } from "@/client/change-trails";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Plural: ({ value }: { value: number }) => <>{value}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { documentsRef } = vi.hoisted(() => ({
  documentsRef: {
    current: null as null | { uri: string; path: string; scope: "live" | "draft" }[],
  },
}));

vi.mock("@/client/query/useTurnLiveLineage", () => ({
  useTurnLiveLineage: () => ({ documents: documentsRef.current }),
}));
vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
}));

const { AssistantTurn } = await import("./AssistantTurn");

afterEach(() => {
  document.body.replaceChildren();
});

function turn(id: string, status: Turn["status"] = "complete"): Turn {
  return {
    id,
    threadId: "thread-1",
    role: "assistant",
    status,
    createdAt: "2026-07-04T00:00:00.000Z",
    blocks: [],
  } as unknown as Turn;
}

describe("AssistantTurn edit lineage", () => {
  it("renders no edit card without lineage documents", () => {
    documentsRef.current = [];
    const html = renderToStaticMarkup(<AssistantTurn threadId="thread-1" turn={turn("turn-1")} />);
    expect(html).not.toContain("data-turn-edits-card");
  });

  it("renders the edit card from server lineage", () => {
    documentsRef.current = [{ uri: "context://doc/chapter-1", path: "/chapter-1", scope: "live" }];
    const html = renderToStaticMarkup(<AssistantTurn threadId="thread-1" turn={turn("turn-1")} />);
    expect(html).toContain("data-turn-edits-card");
    expect(html).toContain("Can&#x27;t undo");
  });
});

describe("AssistantTurn change view", () => {
  it("keeps an errored turn's settled change view reachable across reload", async () => {
    documentsRef.current = [];
    const stableTurn = turn("turn-1", "error");
    const navigateToChange = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const trail = (state: ChangeTrailShell["state"], version: number): ChangeTrailShell => ({
      trailId: "trail-1",
      owner: { kind: "turn", threadId: "thread-1", turnId: stableTurn.id },
      state,
      version,
      changeCount: 2,
      sweptChangeCount: 0,
      documentCount: 1,
      updatedAt: `2026-07-04T00:00:0${version}.000Z`,
      settledAt: state === "settled" ? `2026-07-04T00:00:0${version}.000Z` : null,
    });
    const renderTrail = (changeTrail: ChangeTrailShell) => (
      <QueryClientProvider client={queryClient}>
        <AssistantTurn
          threadId="thread-1"
          turn={stableTurn}
          changeTrail={changeTrail}
          navigateToChange={navigateToChange}
        />
      </QueryClientProvider>
    );

    await act(async () => root.render(renderTrail(trail("building", 2))));
    expect(host.querySelector("[data-turn-edits-card]")).toBeNull();

    await act(async () => root.render(renderTrail(trail("settled", 3))));
    expect(host.querySelector("[data-turn-edits-card]")).not.toBeNull();
    expect(host.querySelector("[data-change-trail-state]")).toBeNull();
    expect(host.textContent).not.toContain("Finishing change record…");

    await act(async () => root.unmount());

    const reloadedHost = document.createElement("div");
    document.body.append(reloadedHost);
    const reloadedRoot = createRoot(reloadedHost);
    await act(async () => reloadedRoot.render(renderTrail(trail("settled", 3))));
    expect(reloadedHost.querySelector("[data-turn-edits-card]")).not.toBeNull();
    await act(async () => reloadedRoot.unmount());
  });
});
