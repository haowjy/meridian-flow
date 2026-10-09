// @vitest-environment jsdom
/** Read-order witnesses retained until T731 crosses the real query/provider boundary. */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  applied,
  change,
  createReviewScopeFixture,
  deferredReviewAnswer,
  draftA,
  listed,
  preview,
  previewOf,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";

let fixture: ReturnType<typeof createReviewScopeFixture>;
let mocks: ReturnType<typeof createReviewScopeFixture>["network"];
const renderReviewScopes: typeof fixture.render = (...args) => fixture.render(...args);
const classIds = (probe: ScopeProbe) => probe.header.view.items.map((item) => item.change.classId);
async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}
beforeEach(() => {
  fixture = createReviewScopeFixture();
  mocks = fixture.network;
  resetDraftCommandRecords();
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(preview);
});
afterEach(() => fixture.dispose());

describe("the room-opening read", () => {
  it("cannot bring back a change handled while it was in flight", async () => {
    mocks.applyDraftChanges.mockResolvedValue(applied(false));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => probe().editor.controller.exitInlineReview());

      const oldRead = deferredReviewAnswer<typeof preview>();
      mocks.getDraftPreview.mockReturnValueOnce(oldRead.promise);
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      expect(probe().editor.controller.reviewRoomName).toBeNull();
      // The list is already actionable from the cache.
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-1", "class-2"]));

      mocks.getDraftPreview.mockResolvedValue(previewOf("1"));
      await act(async () => {
        await probe().editor.controller.applyChanges(draftA, change("2"));
      });
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-1"]));

      // The older read answers last, with the change still in it.
      await act(async () => oldRead.resolve(preview));
      await act(async () => undefined);
      expect(classIds(probe())).toEqual(["class-1"]);
      // The review still finds its room.
      await vi.waitFor(() =>
        expect(probe().editor.controller.reviewRoomName).toBe("review-room-a"),
      );
    });
  });

  it("commits no room to a review that has moved on", async () => {
    await renderReviewScopes(async (probe) => {
      await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
      const slow = deferredReviewAnswer<typeof preview>();
      mocks.getDraftPreview.mockReturnValueOnce(slow.promise);
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await act(async () => probe().editor.controller.exitInlineReview());
      await act(async () => slow.resolve({ ...preview, reviewRoomName: "stale-room" }));
      expect(probe().editor.controller.reviewRoomName).toBeNull();
      expect(probe().editor.controller.inlineReview).toBeNull();
    });
  });
});
