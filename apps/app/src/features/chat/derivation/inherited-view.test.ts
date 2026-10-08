// @vitest-environment jsdom
/** A fork's inherited view: pages folded into owned turns, the optimistic prefix, and paging. */
import type { TranscriptPageResponse, Turn } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ readThreadTranscript: vi.fn() }));
vi.mock("@/client/api/threads-api", () => api);
vi.mock("@/client/stores", () => ({ useIsThreadPendingCreation: () => false }));

import {
  type InheritedView,
  type InheritedViewState,
  inheritedQueryOptions,
  inheritedViewFromPages,
  optimisticForkPrefix,
  useInheritedView,
} from "./inherited-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const turn = (id: string, threadId: string, role = "user") =>
  ({ id, threadId, role, status: "complete", blocks: [] }) as unknown as Turn;
const entry = (id: string, owner: string) => ({
  turn: turn(id, owner),
  blocks: [{ id: `${id}-b` }] as unknown as TranscriptPageResponse["entries"][number]["blocks"],
  ownerThreadId: owner,
});
const page = (
  entries: TranscriptPageResponse["entries"],
  extra: Partial<TranscriptPageResponse> = {},
): TranscriptPageResponse => ({
  entries,
  owners: [
    { threadId: "grand", ref: "c1", title: "Arc 3", trashed: true },
    { threadId: "source", ref: "c2", title: "Chapter 12 plan", trashed: false },
  ],
  segment: { index: 0, bakeId: null, openedBy: null },
  segmentBoundary: false,
  hasMore: false,
  ...extra,
});

beforeEach(() => api.readThreadTranscript.mockReset());

describe("inheritedQueryOptions", () => {
  it("reads the inherited range oldest first, across segment boundaries, until the end", async () => {
    api.readThreadTranscript
      .mockResolvedValueOnce(
        page([entry("s1", "source")], { hasMore: true, segmentBoundary: true, nextCursor: "n1" }),
      )
      .mockResolvedValueOnce(page([entry("s2", "source")]));
    const client = new QueryClient();
    const view = await client.fetchQuery(inheritedQueryOptions("fork"));
    expect(api.readThreadTranscript.mock.calls.map((call) => call[1])).toEqual([
      { range: "inherited", order: "oldest_first", unit: "turn", limit: 200 },
      { range: "inherited", order: "oldest_first", unit: "turn", limit: 200, cursor: "n1" },
    ]);
    expect(view.transcript.turns.map((t) => t.id)).toEqual(["s1", "s2"]);
  });
});

describe("optimisticForkPrefix", () => {
  it("cuts at an inherited turn of a fork, inheriting only above it", () => {
    const sourceInherited = inheritedViewFromPages([
      page([entry("g1", "grand"), entry("g2", "grand")]),
    ]);
    const prefix = optimisticForkPrefix({
      source: { id: "source", title: null },
      sourceInherited,
      localTurns: [turn("s1", "source")],
      cutoffTurnId: "g1",
    });
    expect(prefix?.transcript.turns.map((t) => t.id)).toEqual(["g1"]);
  });

  it("shows nothing it cannot place: an unknown cutoff yields no prefix", () => {
    expect(
      optimisticForkPrefix({
        source: { id: "source", title: null },
        sourceInherited: null,
        localTurns: [turn("s1", "source")],
        cutoffTurnId: "missing",
      }),
    ).toBeNull();
  });
});

describe("useInheritedView", () => {
  async function mountFork(optimistic: InheritedView | null) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const latest: { current: InheritedViewState | null } = { current: null };
    function Probe() {
      latest.current = useInheritedView({ id: "fork", originType: "fork" }, optimistic);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe))),
    );
    return { latest, unmount: () => act(async () => root.unmount()) };
  }

  it("says the history is missing when the read fails and nothing stands in, and Retry reads again", async () => {
    api.readThreadTranscript.mockRejectedValueOnce(new Error("offline"));
    const { latest, unmount } = await mountFork(null);
    await vi.waitFor(() => expect(latest.current?.failed).toBe(true));
    expect(latest.current?.view).toBeNull();

    api.readThreadTranscript.mockResolvedValueOnce(page([entry("s1", "source")]));
    await act(async () => latest.current?.retry());
    await vi.waitFor(() => expect(latest.current?.failed).toBe(false));
    expect(latest.current?.view?.transcript.turns.map((t) => t.id)).toEqual(["s1"]);
    await unmount();
  });

  it("keeps the optimistic prefix on screen when the read fails, so nothing is missing", async () => {
    api.readThreadTranscript.mockRejectedValueOnce(new Error("offline"));
    const optimistic = inheritedViewFromPages([page([entry("s1", "source")])]);
    const { latest, unmount } = await mountFork(optimistic);
    await vi.waitFor(() => expect(api.readThreadTranscript).toHaveBeenCalled());
    await act(async () => undefined);
    expect(latest.current).toMatchObject({ failed: false, view: optimistic });
    await unmount();
  });
});
