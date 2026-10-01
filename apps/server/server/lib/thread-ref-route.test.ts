/** by-ref route core: owner-gated, exact live handle lookup, uniform 404s. */
import type { UserId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { handleGetThreadByRef } from "./thread-ref-route.js";

const OWNER = "owner" as UserId;
const thread = { id: "t1", projectId: "p1", ref: "c3" } as Thread;

function deps() {
  return {
    projectRepo: {
      findById: vi.fn(async (id: string) =>
        id === "p1" ? ({ id: "p1", userId: OWNER, deletedAt: null } as never) : null,
      ),
    },
    threads: {
      findLiveByProjectRef: vi.fn(async (_projectId: string, ref: string) =>
        ref === "c3" ? thread : null,
      ),
    },
  };
}

describe("handleGetThreadByRef", () => {
  it("resolves a live ref in an owned project", async () => {
    await expect(
      handleGetThreadByRef(deps(), { projectId: "p1", userId: OWNER, ref: "c3" }),
    ).resolves.toBe(thread);
  });

  it.each(["c9", "x3", "c0", "3f9a"])("404s unknown or malformed ref %s", async (ref) => {
    const d = deps();
    await expect(
      handleGetThreadByRef(d, { projectId: "p1", userId: OWNER, ref }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not look up refs in projects the caller does not own", async () => {
    const d = deps();
    await expect(
      handleGetThreadByRef(d, { projectId: "p1", userId: "someone" as UserId, ref: "c3" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(d.threads.findLiveByProjectRef).not.toHaveBeenCalled();
  });
});
