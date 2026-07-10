/** Regression: reversal mutations settle only after undo availability is current. */
import type { ListTurnLiveLineageResponse } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const { reverseTurnMock } = vi.hoisted(() => ({
  reverseTurnMock: vi.fn(),
}));

vi.mock("@/client/api/reverse-api", () => ({
  reverseDocument: vi.fn(),
  reverseTurn: reverseTurnMock,
}));

const { threadQueryKeys } = await import("./thread-query-keys");
const { useReverseTurnMutation } = await import("./useReverseMutation");

describe("useReverseTurnMutation", () => {
  it("refreshes the Undo affordance after a cant_undo_dependent response", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const lineageResponses: ListTurnLiveLineageResponse[] = [
      {
        documents: [
          {
            documentId: "doc-1",
            uri: "context://doc/chapter-1",
            path: "/chapter-1",
            scope: "live",
          },
        ],
        receipt: { state: "live-active", control: "undo" },
      },
      {
        documents: [
          {
            documentId: "doc-1",
            uri: "context://doc/chapter-1",
            path: "/chapter-1",
            scope: "live",
          },
        ],
        receipt: { state: "cant_undo_dependent", control: "view_change" },
      },
    ];
    let fetchCount = 0;
    let releaseLineageRefresh: (() => void) | undefined;
    const harnessRef: { reverse: ReturnType<typeof useReverseTurnMutation> | null } = {
      reverse: null,
    };

    function Harness() {
      harnessRef.reverse = useReverseTurnMutation("thread-1");
      useQuery({
        queryKey: threadQueryKeys.liveLineage("thread-1", "turn-1"),
        queryFn: async () => {
          const response = lineageResponses[Math.min(fetchCount++, lineageResponses.length - 1)];
          if (fetchCount === 1) return response;
          await new Promise<void>((resolve) => {
            releaseLineageRefresh = resolve;
          });
          return response;
        },
      });
      return null;
    }

    reverseTurnMock.mockResolvedValue({
      status: "cant_undo_dependent",
      documents: [{ uri: "context://doc/chapter-1", status: "cant_undo_dependent" }],
    });

    try {
      await withReactRoot(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          expect(fetchCount).toBe(1);
          expect(
            queryClient.getQueryData<ListTurnLiveLineageResponse>(
              threadQueryKeys.liveLineage("thread-1", "turn-1"),
            )?.receipt?.control,
          ).toBe("undo");

          let mutationSettled = false;
          const mutation = harnessRef.reverse
            ?.mutateAsync({ turnId: "turn-1", direction: "undo" })
            .then(() => {
              mutationSettled = true;
            });
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });

          expect(fetchCount).toBe(2);
          expect(mutationSettled).toBe(false);
          expect(
            queryClient.getQueryData<ListTurnLiveLineageResponse>(
              threadQueryKeys.liveLineage("thread-1", "turn-1"),
            )?.receipt?.control,
          ).toBe("undo");

          releaseLineageRefresh?.();
          await act(async () => {
            await mutation;
          });

          expect(mutationSettled).toBe(true);
          expect(
            queryClient.getQueryData<ListTurnLiveLineageResponse>(
              threadQueryKeys.liveLineage("thread-1", "turn-1"),
            )?.receipt,
          ).toEqual({ state: "cant_undo_dependent", control: "view_change" });
        },
        { drainMacrotask: true },
      );
    } finally {
      queryClient.clear();
    }
  });
});
