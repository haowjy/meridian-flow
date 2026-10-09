// @vitest-environment jsdom
/**
 * The review's room read survives a refresh that cancels it. A refresh
 * (`useReviewRefresh`) invalidates the draft's preview, and TanStack replaces a
 * read in flight: the read that began it follows the replacement, but one that
 * joined it is rejected with `CancelledError`. The room read is either, by
 * arrival order, so both must end with the room of the replacement's generation
 * and no room error. Real provider, controller, query cache and refresh timers
 * over a real Yjs live document; the network is the only fake.
 */

import { isCancelledError } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  listed,
  previewOf,
  renderReviewScopes,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";
import { sessionFor } from "@/test-support/editor-session-fakes";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
const roomRegistry = {
  retainBranchRooms: vi.fn(),
  releaseBranchRooms: vi.fn(),
  getBranchRoom: sessionFor,
};
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => roomRegistry,
}));

const roomOf = (generation: number) => `review-room-a-g${generation}`;
const proposal = (generation: number, ...ids: string[]) => ({
  ...previewOf(...ids),
  draftGeneration: generation,
  reviewRoomName: roomOf(generation),
  draftRevisionToken: `draft-g${generation}-${ids.join("+")}`,
});
const listedAt = (generation: number) => ({
  drafts: [{ ...listed, draftGeneration: generation, updatedAt: "2026-10-09T05:00:00.000Z" }],
});
const classIds = (probe: ScopeProbe) => probe.header.view.items.map((item) => item.change.classId);
const previewKey = projectQueryKeys.workDraftPreview(
  "project-a",
  "work-a",
  "document-a",
  "draft-a",
);

const SETTLE = 650; // past useReviewRefresh's 500 ms settle window

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(proposal(1, "2"));
});

/**
 * Review G is open on a live document the refresh watches. Whether the room read of
 * G+1 joins a preview read the refresh started, or starts the read itself, a second
 * refresh then replaces the held read, which finally answers G+1 with its changes.
 */
it.each([
  "joined",
  "creator",
])("a %s room read keeps the room when a refresh replaces it", async (ordering) => {
  const liveDocument = new Y.Doc();
  try {
    await renderReviewScopes(async (probe) => {
      await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(1)));
      await act(async () =>
        probe().editor.setActiveEditorDocumentId("document-a", { document: liveDocument } as never),
      );

      let answerHeldRead!: (preview: unknown) => void;
      mocks.getDraftPreview.mockReturnValueOnce(
        new Promise((resolve) => (answerHeldRead = resolve)),
      );
      mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
      mocks.listWorkDrafts.mockResolvedValue(listedAt(2));

      const client = probe().queryClient;
      const readsRejected: unknown[] = [];
      const fetchQuery = client.fetchQuery.bind(client);
      vi.spyOn(client, "fetchQuery").mockImplementation((...args) =>
        fetchQuery(...args).catch((error) => {
          readsRejected.push(error);
          throw error;
        }),
      );
      const readsBefore = mocks.getDraftPreview.mock.calls.length;
      const editLive = async (text: string) =>
        act(async () => {
          liveDocument.getMap("peer-edit").set("text", text);
          await new Promise((resolve) => setTimeout(resolve, SETTLE));
        });

      if (ordering === "joined") {
        // The refresh reads list and preview together: the list shows G+1 while the
        // preview is held, so the controller's room read joins the held preview.
        await editLive("first peer edit");
      } else {
        // A list alone shows G+1: the controller starts the preview read.
        await act(async () => {
          await client.invalidateQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          });
        });
      }
      await vi.waitFor(() =>
        expect(probe().editor.controller.inlineReview?.draftGeneration).toBe(2),
      );
      await vi.waitFor(() =>
        expect(mocks.getDraftPreview.mock.calls.length).toBeGreaterThan(readsBefore),
      );
      expect(probe().editor.controller.reviewRoomName).toBeNull();

      await editLive("another writer updated live");
      await vi.waitFor(() =>
        expect(client.getQueryData(previewKey)).toMatchObject({ draftGeneration: 2 }),
      );
      await act(async () => answerHeldRead(proposal(2, "5")));

      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(2)));
      expect(probe().editor.controller.reviewRoomError).toBe(false);
      expect(probe().editor.controller.inlineReview?.roomError).toBeFalsy();
      expect(classIds(probe())).toEqual(["class-5"]);
      // The joiner is the one the cancellation reaches; the creator follows the replacement.
      expect(readsRejected.some(isCancelledError)).toBe(ordering === "joined");
    });
  } finally {
    liveDocument.destroy();
  }
});
