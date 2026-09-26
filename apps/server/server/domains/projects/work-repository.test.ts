/** WorkRepository lifecycle and D17 deletion contract at the domain port boundary. */
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { WorkDeleteBlockedError, WorkLockedError } from "./ports/work-repository.js";

const PROJECT_ID = "project-1";

describe("WorkRepository", () => {
  it("rejects reuse of a deleted creation ID without replacing its reserved handle", async () => {
    const repo = createInMemoryWorkRepository();
    const first = await repo.create({
      id: "same-work-id",
      projectId: PROJECT_ID,
      name: "Book Two",
    });
    await repo.softDelete(first.id);
    const deleted = await repo.findById(first.id);
    await expect(
      repo.create({ id: first.id, projectId: PROJECT_ID, name: "Book Two" }),
    ).rejects.toThrow();
    expect(await repo.findById(first.id)).toEqual(deleted);
  });

  it("rejects soft-delete while a non-deleted thread membership exists", async () => {
    const repo = createInMemoryWorkRepository({ hasLiveThreads: () => true });
    const created = await repo.create({ projectId: PROJECT_ID, name: "Bound" });

    await expect(repo.softDelete(created.id)).rejects.toEqual(
      new WorkDeleteBlockedError("threads"),
    );
    await expect(repo.findById(created.id)).resolves.toMatchObject({ deletedAt: null });
  });

  it("rejects soft-delete while an unreviewed Work draft exists", async () => {
    let hasUnreviewedDraft = true;
    const repo = createInMemoryWorkRepository({
      hasUnreviewedDrafts: () => hasUnreviewedDraft,
    });
    const created = await repo.create({ projectId: PROJECT_ID, name: "Review pending" });

    await expect(repo.softDelete(created.id)).rejects.toEqual(new WorkDeleteBlockedError("drafts"));
    await expect(repo.findById(created.id)).resolves.toMatchObject({ deletedAt: null });

    hasUnreviewedDraft = false;
    await expect(repo.softDelete(created.id)).resolves.toBeUndefined();
  });
});

describe("No Work", () => {
  it("is idempotent, omitted from named lists, and cannot be minted by create", async () => {
    const repo = createInMemoryWorkRepository();
    const first = await repo.ensureNoWork(PROJECT_ID);
    const second = await repo.ensureNoWork(PROJECT_ID);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ isNoWork: true, slug: null, name: "No Work" });
    expect(await repo.listByProject(PROJECT_ID)).toEqual([]);
    expect(await repo.listByProject(PROJECT_ID, { includeNoWork: true })).toEqual([
      expect.objectContaining({ id: first.id, isNoWork: true }),
    ]);
    const named = await repo.create({ projectId: PROJECT_ID, name: "Book Two" });
    expect(named.isNoWork).toBe(false);
    expect(named.slug).toBeTruthy();
  });

  it("throws work_locked on mutate and delete", async () => {
    const repo = createInMemoryWorkRepository();
    const locked = await repo.ensureNoWork(PROJECT_ID);
    await expect(repo.update(locked.id, { name: "Renamed" })).rejects.toBeInstanceOf(
      WorkLockedError,
    );
    await expect(repo.update(locked.id, { goal: "x" })).rejects.toMatchObject({
      code: "work_locked",
    });
    await expect(repo.archive(locked.id)).rejects.toBeInstanceOf(WorkLockedError);
    await expect(repo.unarchive(locked.id)).rejects.toBeInstanceOf(WorkLockedError);
    await expect(repo.softDelete(locked.id)).rejects.toBeInstanceOf(WorkLockedError);
  });
});
