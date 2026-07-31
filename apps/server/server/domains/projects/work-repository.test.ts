/** WorkRepository lifecycle and D17 deletion contract at the domain port boundary. */
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { WorkDeleteBlockedError } from "./ports/work-repository.js";

const PROJECT_ID = "project-1";

describe("WorkRepository", () => {
  it("updates metadata and treats archive as an unguarded visibility state", async () => {
    const repo = createInMemoryWorkRepository({
      hasLiveThreads: () => true,
      hasUnreviewedDrafts: () => true,
    });
    const created = await repo.create({
      projectId: PROJECT_ID,
      name: "Draft",
      goal: "Reach the midpoint",
    });

    const updated = await repo.update(created.id, {
      name: "Book Two",
      description: "The sequel",
    });
    expect(updated).toMatchObject({
      name: "Book Two",
      goal: "Reach the midpoint",
      description: "The sequel",
    });

    const archived = await repo.archive(created.id);
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();
    await expect(repo.unarchive(created.id)).resolves.toMatchObject({
      status: "active",
      archivedAt: null,
    });
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
    const repo = createInMemoryWorkRepository({ hasUnreviewedDrafts: () => true });
    const created = await repo.create({ projectId: PROJECT_ID, name: "Review pending" });

    await expect(repo.softDelete(created.id)).rejects.toEqual(new WorkDeleteBlockedError("drafts"));
    await expect(repo.findById(created.id)).resolves.toMatchObject({ deletedAt: null });
  });

  it("soft-deletes an empty Work", async () => {
    const repo = createInMemoryWorkRepository();
    const created = await repo.create({ projectId: PROJECT_ID, name: "Empty" });

    await repo.softDelete(created.id);
    await expect(repo.findById(created.id)).resolves.toMatchObject({
      deletedAt: expect.any(String),
    });
  });
});
