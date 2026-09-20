/**
 * Continue authority: direct-parent children only; missing, cross-owner, and
 * non-child targets resolve to clean tool errors without leaking existence.
 * Targets are addressed by project-scoped `cN`/`pN` handle, not a UUID.
 */
import type { ProjectId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { authorizeContinueTarget } from "./authorize-continue-target.js";

const CALLER_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";

const caller = {
  id: CALLER_ID,
  projectId: "project-1",
  userId: "user-1",
} as unknown as Thread;

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: TARGET_ID,
    projectId: "project-1",
    userId: "user-1",
    kind: "subagent",
    parentThreadId: CALLER_ID,
    ...overrides,
  } as unknown as Thread;
}

function threads(target: Thread | null, onLookup?: (projectId: string, ref: string) => void) {
  return {
    async findLiveByProjectRef(projectId: ProjectId, ref: string): Promise<Thread | null> {
      onLookup?.(projectId, ref);
      return target;
    },
  };
}

async function authorize(target: Thread | null, handle = "p1") {
  return authorizeContinueTarget({
    callerThread: caller,
    targetHandle: handle,
    threads: threads(target),
  });
}

describe("authorizeContinueTarget", () => {
  it("authorizes a direct child of the caller resolved by handle", async () => {
    const target = thread({});
    const outcome = await authorize(target, "p3");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.target).toEqual(target);
  });

  it("resolves the handle within the caller's project", async () => {
    let scopedProject: string | undefined;
    const outcome = await authorizeContinueTarget({
      callerThread: caller,
      targetHandle: "p1",
      threads: threads(thread({}), (projectId) => {
        scopedProject = projectId;
      }),
    });
    expect(outcome.ok).toBe(true);
    expect(scopedProject).toBe(caller.projectId);
  });

  it("hides a missing target behind continue_target_not_found", async () => {
    const outcome = await authorize(null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("continue_target_not_found");
  });

  it("rejects a malformed handle before any lookup with continue_target_not_found", async () => {
    let lookups = 0;
    const outcome = await authorizeContinueTarget({
      callerThread: caller,
      targetHandle: "not-a-handle",
      threads: {
        async findLiveByProjectRef() {
          lookups += 1;
          return thread({});
        },
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("continue_target_not_found");
    expect(lookups).toBe(0);
  });

  it.each([
    "c0",
    "p0",
    "p01",
    "x1",
    "1",
    "p1.5",
  ])("rejects the malformed handle %s before any lookup", async (handle) => {
    let lookups = 0;
    const outcome = await authorizeContinueTarget({
      callerThread: caller,
      targetHandle: handle,
      threads: {
        async findLiveByProjectRef() {
          lookups += 1;
          return thread({});
        },
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("continue_target_not_found");
    expect(lookups).toBe(0);
  });

  it("hides a target owned by another user behind continue_target_not_found", async () => {
    const outcome = await authorize(thread({ userId: "user-2" }));
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
