/** What a chat link resolves against while, and after, the thread's Work loads. */

import { describe, expect, it } from "vitest";

import { chatLinkScope } from "./useChatLinkFollowing";

const projectId = "project-1";

describe("chatLinkScope", () => {
  it("uses the thread's Work once the snapshot names it", () => {
    expect(
      chatLinkScope({ projectId, activeWork: { id: "work-1" }, thread: null, worksSettled: false }),
    ).toEqual({ projectId, workId: "work-1", baseUri: null });
  });

  it("waits while the snapshots that name the Work are loading", () => {
    expect(
      chatLinkScope({
        projectId,
        activeWork: null,
        thread: { workId: "work-1" },
        worksSettled: false,
      }),
    ).toBe("pending");
    expect(chatLinkScope({ projectId, activeWork: null, thread: null, worksSettled: true })).toBe(
      "pending",
    );
  });

  it("stops waiting for a Work the loaded snapshot does not have, asking with the thread's own binding", () => {
    expect(
      chatLinkScope({
        projectId,
        activeWork: null,
        thread: { workId: "deleted-work" },
        worksSettled: true,
      }),
    ).toEqual({ projectId, workId: "deleted-work", baseUri: null });
  });
});
