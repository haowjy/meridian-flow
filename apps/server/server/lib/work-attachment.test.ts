import { describe, expect, it, vi } from "vitest";
import { resolveWorkMembership } from "./work-attachment.js";

const threadWorks = (parentWorkId: string | null) => ({
  findPrimary: vi.fn(async () => (parentWorkId ? { workId: parentWorkId } : null)),
  addMembership: vi.fn(async () => undefined),
});

describe("resolveWorkMembership", () => {
  it("keeps an omitted or explicit-null root unassigned", async () => {
    for (const workId of [undefined, null]) {
      const memberships = threadWorks(null);
      await expect(
        resolveWorkMembership(
          { workRepo: { findById: vi.fn() } as never, threadWorks: memberships as never },
          { threadId: "thread", projectId: "project", workId },
        ),
      ).resolves.toBeNull();
      expect(memberships.addMembership).not.toHaveBeenCalled();
    }
  });

  it("inherits a parent's absent scope", async () => {
    const memberships = threadWorks(null);
    await expect(
      resolveWorkMembership(
        { workRepo: { findById: vi.fn() } as never, threadWorks: memberships as never },
        { threadId: "child", projectId: "project", parentThreadId: "parent" },
      ),
    ).resolves.toBeNull();
    expect(memberships.addMembership).not.toHaveBeenCalled();
  });

  it("inherits a parent's real Work", async () => {
    const memberships = threadWorks("work");
    await expect(
      resolveWorkMembership(
        { workRepo: { findById: vi.fn() } as never, threadWorks: memberships as never },
        { threadId: "child", projectId: "project", parentThreadId: "parent" },
      ),
    ).resolves.toBe("work");
    expect(memberships.addMembership).toHaveBeenCalledWith("child", "work", true);
  });
});
