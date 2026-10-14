// @vitest-environment jsdom
/** A text draft's Discard is an undoable edit: with no editor to own that edit it waits, and never closes the item. */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { createReviewScopeFixture, draftA, listed, meta } from "@/test-support/draft-review-scope";
import { settleReact } from "@/test-support/react-dom-harness";

it("an ordinary text draft with no attached editor does not fall back to server close", async () => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  const fixture = createReviewScopeFixture();
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [listed] });
  fixture.network.getDraftMeta.mockResolvedValue(meta as never);
  try {
    await fixture.render(async (read) => {
      await act(async () =>
        read().presented.controller.enterInlineReview(draftA.documentId, draftA.itemKey),
      );
      await settleReact(() => expect(read().presented.roomOwner.roomName).toBe(meta.roomName));
      expect(read().presented.controller.wholeItem).toBe(false);
      await act(async () => {
        const outcome = await read().presented.controller.discard(
          draftA.documentId,
          draftA.itemKey,
        );
        expect(outcome).toEqual({ kind: "blocked" });
      });
      expect(fixture.network.discardDraft).not.toHaveBeenCalled();
    });
  } finally {
    fixture.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
