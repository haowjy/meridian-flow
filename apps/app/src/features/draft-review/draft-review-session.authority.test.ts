/** Command and batch reservations are released when their owning ports are unavailable. */
import { beforeEach, describe, expect, it } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { DraftReviewSession } from "./draft-review-session";

const selection = { documentId: "doc", draftId: "draft" };
const change = { classIds: ["class"], operationIds: ["1", "2"] };
const tokens = { liveRevisionToken: "live-1", draftRevisionToken: "draft-1", draftGeneration: 1 };

describe("a session whose ports cannot be resolved", () => {
  beforeEach(() => resetDraftCommandRecords());

  it("gives its disposition reservation back, for a command and for a batch", async () => {
    const session = new DraftReviewSession(() => {
      throw new Error("Draft review command ports are not ready.");
    });

    await expect(session.applySelection(selection, change, tokens)).rejects.toThrow("not ready");
    expect(session.disposition.getSnapshot()).toEqual({ busy: false });
    await expect(session.disposeDrafts("discard", [selection])).rejects.toThrow("not ready");
    expect(session.disposition.getSnapshot()).toEqual({ busy: false });
  });
});
