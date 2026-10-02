/** What a chat link resolves against while, and after, the thread's Work loads. */

import { describe, expect, it } from "vitest";

import { chatLinkScope } from "./useChatLinkFollowing";

const projectId = "project-1";
const settled = { projectId, worksSettled: true, noWorkId: "no-work" };

describe("chatLinkScope", () => {
  it("uses the thread's Work once the snapshot names it", () => {
    expect(chatLinkScope({ ...settled, activeWork: { id: "work-1" }, thread: null })).toEqual({
      projectId,
      workId: "work-1",
      baseUri: null,
    });
  });

  it("waits while the snapshots that name the Work are loading", () => {
    expect(
      chatLinkScope({
        projectId,
        activeWork: null,
        thread: { workId: "work-1" },
        worksSettled: false,
        noWorkId: null,
      }),
    ).toBe("pending");
    expect(chatLinkScope({ ...settled, activeWork: null, thread: null })).toBe("pending");
  });

  it("names a No Work thread by the No Work row whichever snapshot answers first", () => {
    const fromThread = chatLinkScope({ ...settled, activeWork: null, thread: { workId: null } });
    const fromWorks = chatLinkScope({ ...settled, activeWork: { id: "no-work" }, thread: null });

    expect(fromThread).toEqual(fromWorks);
  });

  it("stops waiting for a Work the loaded snapshot does not have, asking with the thread's own binding", () => {
    expect(
      chatLinkScope({ ...settled, activeWork: null, thread: { workId: "deleted-work" } }),
    ).toEqual({ projectId, workId: "deleted-work", baseUri: null });
  });
});
