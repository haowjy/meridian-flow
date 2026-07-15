/** Contract-level coverage for DraftDock refusal normalization. */
import type { DraftApplyRefusal } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import { draftApplyRefusalFromResponse } from "./draft-apply-refusal";

describe("draftApplyRefusalFromResponse", () => {
  it("renders protected resurrection evidence from the real server refusal contract", () => {
    const response: DraftApplyRefusal = {
      status: "concurrent_conflict",
      reason: "draft_base_divergence",
      conflictedBlocks: ["block-1"],
      conflicts: [
        {
          blockId: "block-1",
          journalIds: [17],
          draftBaseUpdateSeq: 41,
          effect: "resurrection",
          evidence: "human_live_deletion",
          captured: {
            base: "block-1|Deleted by the writer.",
            live: null,
            proposed: "block-2|Deleted by the writer.",
          },
          why: "Apply would restore writer-deleted text.",
        },
      ],
    };

    expect(draftApplyRefusalFromResponse(response)).toEqual({
      reason: "protected_resurrection",
      passages: [{ body: "Deleted by the writer." }],
    });
  });
});
