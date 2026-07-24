/** Lifecycle proofs for authorization-sensitive change-trail detail. */
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeTrailShell } from "@/client/change-trails";
import { useAuthorizedChangeTrailDetail } from "./useAuthorizedChangeTrailDetail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  readChangeTrail: vi.fn(),
  authorizationObserver: undefined as ((snapshot: { status: string }) => void) | undefined,
}));
vi.mock("@/client/change-trails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/change-trails")>()),
  readChangeTrail: mocks.readChangeTrail,
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    observe: (_documentId: string, observer: (snapshot: { status: string }) => void) => {
      mocks.authorizationObserver = observer;
      return () => {
        mocks.authorizationObserver = undefined;
      };
    },
  }),
}));

const shell = (version = 1): ChangeTrailShell => ({
  trailId: "trail-1",
  owner: { kind: "turn", threadId: "thread-1", turnId: "turn-1" },
  state: "settled",
  version,
  changeCount: 1,
  sweptChangeCount: 0,
  documentCount: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  settledAt: "2026-01-01T00:00:00.000Z",
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.authorizationObserver = undefined;
  document.body.replaceChildren();
});

describe("useAuthorizedChangeTrailDetail", () => {
  it("loads on disclosure and evicts detail when document access is revoked", async () => {
    mocks.readChangeTrail.mockResolvedValue([
      {
        trailId: "trail-1",
        documentId: "document-1",
        documentTitle: "Chapter",
        anchorState: "available",
        changes: [],
      },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    function Harness({ enabled }: { enabled: boolean }) {
      useAuthorizedChangeTrailDetail("thread-1", shell(), enabled);
      return null;
    }
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness enabled={false} />
        </QueryClientProvider>,
      );
    });
    expect(mocks.readChangeTrail).not.toHaveBeenCalled();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness enabled />
        </QueryClientProvider>,
      );
    });
    await act(async () => Promise.resolve());
    expect(mocks.readChangeTrail).toHaveBeenCalledWith("thread-1", "trail-1");
    await vi.waitFor(() => expect(mocks.authorizationObserver).toBeTypeOf("function"));
    await act(async () => mocks.authorizationObserver?.({ status: "access-lost" }));
    expect(queryClient.getQueriesData({ queryKey: ["change-trail-detail", "thread-1"] })).toEqual(
      [],
    );
    await act(async () => root.unmount());
  });
});
