// @vitest-environment jsdom
/** Apply is done at server confirmation; a lost response stays unknown; a confirmed draft never returns from an older read. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { resetDraftCommandRecords } from "./draft-command-record";
import { DraftCommandOutcomeUnknownError, useApplyDraft } from "./useDraftReviewMutations";
import { useWorkDrafts } from "./useWorkDrafts";

const api = vi.hoisted(() => ({
  applyDraft: vi.fn(),
  discardDraft: vi.fn(),
  listWorkDrafts: vi.fn(),
}));
vi.mock("@/client/api/drafts-api", () => api);

const input = {
  projectId: "project-a",
  workId: "work-a",
  documentId: "doc-a",
  draftId: "draft-a",
  draftGeneration: 1,
};
const lost = () => new TypeError("Failed to fetch");
const listing = (...draftIds: string[]) => ({
  drafts: draftIds.map((draftId) => ({ draftId, documentId: "doc-a" }) as ThreadDraftListItem),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Harness = {
  apply: () => Promise<unknown>;
  listed: () => string[];
  queryClient: QueryClient;
};

async function withHarness(run: (harness: Harness) => Promise<void>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let mutate!: ReturnType<typeof useApplyDraft>["mutateAsync"];
  let drafts: string[] = [];
  function Capture() {
    mutate = useApplyDraft().mutateAsync;
    drafts = (useWorkDrafts("project-a", "work-a").drafts ?? []).map((draft) => draft.draftId);
    return null;
  }
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <Capture />
    </QueryClientProvider>,
    () =>
      run({
        apply: () =>
          mutate(input).then(
            () => "applied",
            (error: unknown) => error,
          ),
        listed: () => drafts,
        queryClient,
      }),
  );
}

describe("useApplyDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    api.listWorkDrafts.mockResolvedValue(listing("draft-a"));
  });

  it("keeps a lost response unknown even when a remote Discard emptied the list", async () => {
    await withHarness(async ({ apply, listed }) => {
      await vi.waitFor(() => expect(listed()).toEqual(["draft-a"]));
      api.applyDraft.mockRejectedValue(lost());
      api.listWorkDrafts.mockResolvedValue(listing());
      await act(async () => expect(await apply()).toBeInstanceOf(DraftCommandOutcomeUnknownError));
      await vi.waitFor(() => expect(listed()).toEqual([]));
    });
  });

  it("drops a confirmed draft at once, and no initial read that started earlier brings it back", async () => {
    // No cached list: nothing but the read fence can keep the older read's
    // draft out, since a later refetch would be cancelled by the invalidation.
    api.listWorkDrafts.mockReturnValue(new Promise(() => undefined));
    await withHarness(async ({ apply, listed, queryClient }) => {
      const confirmation = deferred<unknown>();
      api.applyDraft.mockReturnValue(confirmation.promise);
      const older = deferred<ReturnType<typeof listing>>();
      let applied!: Promise<unknown>;
      await act(async () => {
        applied = apply();
      });
      api.listWorkDrafts.mockReturnValueOnce(older.promise);
      await act(async () => {
        void queryClient.refetchQueries({ queryKey: ["projects", "project-a"] });
      });
      await act(async () => {
        confirmation.resolve({ status: "applied", draftId: "draft-a" });
        await applied;
      });
      await act(async () => older.resolve(listing("draft-a")));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(listed()).toEqual([]);
    });
  });
});
