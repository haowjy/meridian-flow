/**
 * Continue authority: direct-parent children only; missing, cross-owner, and
 * non-child targets resolve to clean tool errors without leaking existence.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { authorizeContinueTarget } from "./authorize-continue-target.js";

const caller = {
  id: "caller",
  projectId: "project-1",
  userId: "user-1",
} as unknown as Thread;

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "target",
    projectId: "project-1",
    userId: "user-1",
    kind: "subagent",
    parentThreadId: "caller",
    ...overrides,
  } as unknown as Thread;
}

function threads(target: Thread | null) {
  return {
    async findById(): Promise<Thread | null> {
      return target;
    },
  };
}

async function authorize(target: Thread | null) {
  return authorizeContinueTarget({
    callerThread: caller,
    targetThreadId: (target?.id ?? "ghost") as ThreadId,
    threads: threads(target),
  });
}

describe("authorizeContinueTarget", () => {
  it("authorizes a direct child of the caller", async () => {
    const target = thread({});
    const outcome = await authorize(target);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.target).toEqual({ kind: "child", thread: target });
  });

  it("hides a missing target behind continue_target_not_found", async () => {
    const outcome = await authorize(null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("continue_target_not_found");
  });

  it("hides a target owned by another user behind continue_target_not_found", async () => {
    const outcome = await authorize(thread({ userId: "user-2" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("continue_target_not_found");
  });

  it("hides a target in another project behind continue_target_not_found", async () => {
    const outcome = await authorize(thread({ projectId: "project-2" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("continue_target_not_found");
  });

  it("rejects a non-child subagent with continue_target_not_authorized", async () => {
    const outcome = await authorize(thread({ parentThreadId: "someone-else" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("continue_target_not_authorized");
  });

  it("rejects a primary thread with continue_target_not_authorized", async () => {
    const outcome = await authorize(thread({ kind: "primary", parentThreadId: null }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("continue_target_not_authorized");
  });
});
