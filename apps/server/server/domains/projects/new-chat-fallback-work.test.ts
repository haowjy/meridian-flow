/** Fast policy checks for new-chat fallback ownership and resolver sequencing. */
import type { Project } from "@meridian/contracts/projects";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { resolveNewChatFallbackWork } from "./new-chat-fallback-work.js";

const USER_ID = "user-1";
const PROJECT_ID = "project-1";
const project = { id: PROJECT_ID, userId: USER_ID, name: "My Book" } as Project;

function work(id: string, status: Work["status"] = "active"): Work {
  return { id, projectId: PROJECT_ID, status, deletedAt: null } as Work;
}

describe("resolveNewChatFallbackWork", () => {
  it("persists the resolved fallback so archiving its Work does not change it", async () => {
    const older = work("older");
    const newer = work("newer");
    let fallbackWorkId: string | null = null;
    const rows = [newer, older];
    const deps = {
      preferences: {
        getNewChatFallbackWorkId: async () => fallbackWorkId,
        repairNewChatFallbackWorkId: async (
          _userId: string,
          _projectId: string,
          expectedWorkId: string | null,
          workId: string,
        ) => {
          if (fallbackWorkId !== expectedWorkId) return false;
          fallbackWorkId = workId;
          return true;
        },
      },
      works: {
        findById: async (id: string) => rows.find((candidate) => candidate.id === id) ?? null,
        listByProject: async (_projectId: string, options?: { status?: Work["status"] }) =>
          rows.filter((candidate) => candidate.status === options?.status),
      },
    } as never;

    await expect(resolveNewChatFallbackWork(deps, { userId: USER_ID }, project)).resolves.toBe(
      newer,
    );
    expect(fallbackWorkId).toBe(newer.id);

    newer.status = "archived";
    await expect(resolveNewChatFallbackWork(deps, { userId: USER_ID }, project)).resolves.toBe(
      newer,
    );
  });

  it("keeps a saved archived Work as the new-chat fallback", async () => {
    const fallback = work("fallback", "archived");
    const listByProject = vi.fn();

    await expect(
      resolveNewChatFallbackWork(
        {
          preferences: { getNewChatFallbackWorkId: async () => fallback.id } as never,
          works: { findById: async () => fallback, listByProject } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(fallback);
    expect(listByProject).not.toHaveBeenCalled();
  });

  it("repairs a dangling fallback pointer to the most recently updated active Work", async () => {
    const active = work("active");
    const listByProject = vi.fn(async (_projectId, options) =>
      options?.status === "active" ? [active] : [],
    );

    await expect(
      resolveNewChatFallbackWork(
        {
          preferences: {
            getNewChatFallbackWorkId: async () => "deleted",
            repairNewChatFallbackWorkId: async () => true,
          } as never,
          works: { findById: async () => null, listByProject } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(active);
    expect(listByProject).toHaveBeenCalledWith(PROJECT_ID, { status: "active" });
  });

  it("repairs a soft-deleted fallback so restoring the old Work does not reclaim the pointer", async () => {
    const deleted = work("deleted");
    deleted.deletedAt = new Date().toISOString();
    const active = work("active");
    let fallbackWorkId = deleted.id;
    const deps = {
      preferences: {
        getNewChatFallbackWorkId: async () => fallbackWorkId,
        repairNewChatFallbackWorkId: async (
          _userId: string,
          _projectId: string,
          expectedWorkId: string | null,
          workId: string,
        ) => {
          if (fallbackWorkId !== expectedWorkId) return false;
          fallbackWorkId = workId;
          return true;
        },
      },
      works: {
        findById: async (id: string) => {
          if (id === deleted.id) return deleted;
          if (id === active.id) return active;
          return null;
        },
        listByProject: async (_projectId: string, options?: { status?: Work["status"] }) =>
          options?.status === "active" ? [active] : [],
      },
    } as never;

    await expect(resolveNewChatFallbackWork(deps, { userId: USER_ID }, project)).resolves.toBe(
      active,
    );
    expect(fallbackWorkId).toBe(active.id);

    deleted.deletedAt = null;
    await expect(resolveNewChatFallbackWork(deps, { userId: USER_ID }, project)).resolves.toBe(
      active,
    );
  });

  it("uses the newest archived Work when no active Work remains", async () => {
    const archived = work("archived", "archived");
    const listByProject = vi.fn(async (_projectId, options) =>
      options?.status === "archived" ? [archived] : [],
    );

    await expect(
      resolveNewChatFallbackWork(
        {
          preferences: {
            getNewChatFallbackWorkId: async () => null,
            repairNewChatFallbackWorkId: async () => true,
          } as never,
          works: { listByProject } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(archived);
  });

  it("creates a concretely named default only when the project has no Work", async () => {
    const created = work("created");
    const ensureDefaultForProject = vi.fn(async () => created);

    await expect(
      resolveNewChatFallbackWork(
        {
          preferences: {
            getNewChatFallbackWorkId: async () => null,
            repairNewChatFallbackWorkId: async () => true,
          } as never,
          works: {
            listByProject: async () => [],
            ensureDefaultForProject,
          } as never,
        },
        { userId: USER_ID },
        project,
      ),
    ).resolves.toBe(created);
    expect(ensureDefaultForProject).toHaveBeenCalledWith(PROJECT_ID, "My Book");
  });
});
