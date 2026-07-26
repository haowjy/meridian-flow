/** Wire-boundary coverage for draft review responses. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getDraftPreview } from "./drafts-api";

afterEach(() => vi.unstubAllGlobals());

describe("draft preview response", () => {
  it("rejects an active response without its review room", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          Response.json({
            status: "active",
            draftId: "branch_test-draft",
            live: "Live text",
            preview: "Draft text",
            liveRevisionToken: 1,
            draftRevisionToken: 2,
            inlineModelPresent: true,
            operations: [],
            hunks: [],
          }),
        ),
      ),
    );

    await expect(
      getDraftPreview("project-1", "work-1", "document-1", "branch_test-draft"),
    ).rejects.toThrow("Draft preview response is missing reviewRoomName");
  });
});
