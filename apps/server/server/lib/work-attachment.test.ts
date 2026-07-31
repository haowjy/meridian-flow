/** Attachment precedence: explicit, parent primary, writer current, final default. */
import type { Project } from "@meridian/contracts/projects";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { resolveWorkMembership } from "./work-attachment.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const THREAD_ID = "00000000-0000-4000-8000-000000000003";
const PARENT_ID = "00000000-0000-4000-8000-000000000004";
const project = { id: PROJECT_ID, userId: USER_ID, name: "Novel" } as Project;

function work(id: string): Work {
  return { id, projectId: PROJECT_ID, deletedAt: null, status: "active" } as Work;
}

describe("resolveWorkMembership", () => {
  it("prefers an explicit Work over parent and current selections", async () => {
    const explicit = work("explicit");
    const findPrimary = vi.fn();
    const getCurrentWorkId = vi.fn();
    const addMembership = vi.fn();

    await expect(
      resolveWorkMembership(
        {
          workRepo: { findById: async () => explicit } as never,
          preferences: { getCurrentWorkId } as never,
          threadWorks: { findPrimary, addMembership } as never,
        },
        {
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          project,
          userId: USER_ID,
          workId: explicit.id,
          parentThreadId: PARENT_ID,
        },
      ),
    ).resolves.toBe(explicit.id);
    expect(findPrimary).not.toHaveBeenCalled();
    expect(getCurrentWorkId).not.toHaveBeenCalled();
    expect(addMembership).toHaveBeenCalledWith(THREAD_ID, explicit.id, true);
  });

  it("inherits a parent's primary Work before consulting current preference", async () => {
    const parent = work("parent");
    const getCurrentWorkId = vi.fn();
    const addMembership = vi.fn();

    await expect(
      resolveWorkMembership(
        {
          workRepo: {} as never,
          preferences: { getCurrentWorkId } as never,
          threadWorks: {
            findPrimary: async () => ({ workId: parent.id }),
            addMembership,
          } as never,
        },
        {
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          parentThreadId: PARENT_ID,
        },
      ),
    ).resolves.toBe(parent.id);
    expect(getCurrentWorkId).not.toHaveBeenCalled();
    expect(addMembership).toHaveBeenCalledWith(THREAD_ID, parent.id, true);
  });

  it("uses the writer's current preference for a new root conversation", async () => {
    const current = work("current");
    const listByProject = vi.fn();

    await expect(
      resolveWorkMembership(
        {
          workRepo: {
            findById: async () => current,
            listByProject,
          } as never,
          preferences: { getCurrentWorkId: async () => current.id } as never,
          threadWorks: { addMembership: async () => {} } as never,
        },
        { threadId: THREAD_ID, projectId: PROJECT_ID, project, userId: USER_ID },
      ),
    ).resolves.toBe(current.id);
    expect(listByProject).not.toHaveBeenCalled();
  });

  it("creates a concrete default only after every earlier source is absent", async () => {
    const created = work("created");
    const ensureDefaultForProject = vi.fn(async () => created);
    const setCurrentWorkId = vi.fn();

    await expect(
      resolveWorkMembership(
        {
          workRepo: {
            listByProject: async () => [],
            ensureDefaultForProject,
          } as never,
          preferences: {
            getCurrentWorkId: async () => null,
            setCurrentWorkIdIfUnchanged: async (
              _userId: string,
              _projectId: string,
              expectedWorkId: string | null,
              workId: string,
            ) => {
              if (expectedWorkId !== null) return false;
              setCurrentWorkId(_userId, _projectId, workId);
              return true;
            },
          } as never,
          threadWorks: { addMembership: async () => {} } as never,
        },
        { threadId: THREAD_ID, projectId: PROJECT_ID, project, userId: USER_ID },
      ),
    ).resolves.toBe(created.id);
    expect(ensureDefaultForProject).toHaveBeenCalledWith(PROJECT_ID, "Novel");
    expect(setCurrentWorkId).toHaveBeenCalledWith(USER_ID, PROJECT_ID, created.id);
  });
});
