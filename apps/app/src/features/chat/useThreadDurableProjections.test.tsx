/** Convergence proofs for the thread-mounted trail subscription. */
// @vitest-environment jsdom
import { EventType } from "@meridian/contracts/protocol";
import { WORK_CONTEXT_PROJECTION_EVENT } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeTrailShell } from "@/client/change-trails";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { useThreadDurableProjections } from "./useThreadDurableProjections";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listChangeTrailShells: vi.fn(),
  handlers: undefined as { onEvent: (e: unknown) => void; onGap: () => void } | undefined,
}));

vi.mock("@/client/change-trails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/change-trails")>()),
  listChangeTrailShells: mocks.listChangeTrailShells,
}));
// Stable identity: the hook's effect depends on the transport, so a fresh object
// per render would remount the subscription on every commit.
const transport = {
  subscribe: (
    _threadId: string,
    handlers: { onEvent: (e: unknown) => void; onGap: () => void },
  ) => {
    mocks.handlers = handlers;
    return () => {
      mocks.handlers = undefined;
    };
  },
};
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => transport,
}));

const shell = (trailId: string): ChangeTrailShell => ({
  trailId,
  owner: { kind: "turn", threadId: "thread-1", turnId: `turn-${trailId}` },
  state: "settled",
  version: 1,
  changeCount: 1,
  documentCount: 1,
  documents: [{ documentId: `document-${trailId}`, title: "Chapter 1" }],
  wordsAdded: 2,
  wordsRemoved: 2,
  updatedAt: "2026-01-01T00:00:00.000Z",
  settledAt: "2026-01-01T00:00:00.000Z",
});

let cleanup: (() => void) | undefined;

function mount() {
  const seen: ReturnType<typeof useThreadDurableProjections>[] = [];
  function Probe() {
    seen.push(useThreadDurableProjections({ threadId: "thread-1", projectId: "project-1" }));
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return { latest: () => seen.at(-1), queryClient: () => client };
}

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  mocks.handlers = undefined;
  mocks.listChangeTrailShells.mockReset();
});

describe("useThreadDurableProjections", () => {
  it("converges under a gap burst instead of starving on superseded requests", async () => {
    // Each list request is held open so the burst lands while one is in flight —
    // the exact shape that used to leave the map permanently empty.
    const pending: Array<(shells: ChangeTrailShell[]) => void> = [];
    mocks.listChangeTrailShells.mockImplementation(
      () => new Promise<ChangeTrailShell[]>((resolve) => pending.push(resolve)),
    );

    const view = mount();
    expect(pending).toHaveLength(1);

    await act(async () => {
      for (let i = 0; i < 50; i += 1) mocks.handlers?.onGap();
    });

    // The burst asks for one follow-up, not one request per gap.
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0]?.([shell("trail-1")]);
    });
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1]?.([shell("trail-1"), shell("trail-2")]);
    });

    expect(mocks.listChangeTrailShells).toHaveBeenCalledTimes(2);
    expect(Object.keys(view.latest()?.changeTrails.byId ?? {})).toEqual(["trail-1", "trail-2"]);
    expect(view.latest()?.changeTrails.gapPending).toBe(false);
  });

  it("leaves in-flight change-trail detail alone across a gap", async () => {
    // Continuous gaps used to evict detail queries faster than they could resolve,
    // so expanded cards on long threads never showed their change rows.
    mocks.listChangeTrailShells.mockResolvedValue([shell("trail-1")]);
    const view = mount();
    await act(async () => {});

    const client = view.queryClient();
    const detailKey = ["change-trail-detail", "thread-1", "trail-1", 1];
    client.setQueryData(detailKey, [{ changeId: "change-1" }]);

    await act(async () => {
      for (let i = 0; i < 10; i += 1) mocks.handlers?.onGap();
    });

    expect(client.getQueryData(detailKey)).toEqual([{ changeId: "change-1" }]);
  });

  it("applies one typed Work projection once and ignores duplicate journal delivery", async () => {
    mocks.listChangeTrailShells.mockResolvedValue([]);
    const view = mount();
    await act(async () => {});
    const client = view.queryClient();
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
      works: [{ id: "work-c", name: "C" }],
    });
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", projectId: "project-1", workId: "work-a" },
    ]);
    const setQueryData = vi.spyOn(client, "setQueryData");
    const delivery = {
      seq: "9",
      event: {
        type: EventType.CUSTOM,
        name: WORK_CONTEXT_PROJECTION_EVENT,
        value: { threadId: "thread-1", projectId: "project-1", workId: "work-c" },
      },
    };

    await act(async () => {
      mocks.handlers?.onEvent(delivery);
      mocks.handlers?.onEvent(delivery);
    });

    expect(client.getQueryData(threadQueryKeys.workProjectionCursor("thread-1"))).toEqual({
      seq: "9",
      workId: "work-c",
    });
    expect(
      setQueryData.mock.calls.filter(
        ([key]) =>
          JSON.stringify(key) === JSON.stringify(threadQueryKeys.workProjectionCursor("thread-1")),
      ),
    ).toHaveLength(1);
  });
});
