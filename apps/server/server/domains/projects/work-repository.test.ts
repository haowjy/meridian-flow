/** WorkRepository lifecycle and D17 deletion contract at the domain port boundary. */
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { WorkDeleteBlockedError, WorkNameConflictError } from "./ports/work-repository.js";

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

  it.each([
    ["files", { hasDocuments: () => true }, "documents"],
    ["folders", { hasFolders: () => true }, "folders"],
  ] as const)("rejects soft-delete while Work-owned context contains %s", async (_, options, reason) => {
    const repo = createInMemoryWorkRepository(options);
    const created = await repo.create({ projectId: PROJECT_ID, name: "Context held" });

    await expect(repo.softDelete(created.id)).rejects.toEqual(new WorkDeleteBlockedError(reason));
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

  it("rejects case-insensitive active name conflicts", async () => {
    const repo = createInMemoryWorkRepository();
    const first = await repo.create({ projectId: PROJECT_ID, name: "Book Two" });
    const second = await repo.create({ projectId: PROJECT_ID, name: "Book Three" });

    await expect(repo.create({ projectId: PROJECT_ID, name: " book two " })).rejects.toBeInstanceOf(
      WorkNameConflictError,
    );
    await expect(repo.update(second.id, { name: "BOOK TWO" })).rejects.toBeInstanceOf(
      WorkNameConflictError,
    );

    await repo.softDelete(first.id);
    await expect(repo.update(second.id, { name: "BOOK TWO" })).resolves.toMatchObject({
      name: "BOOK TWO",
    });
  });
});

describe("Work entity revisions", () => {
  it("increments create, rename, archive, unarchive, delete, and restore but not lifecycle no-ops", async () => {
    const repo = createInMemoryWorkRepository();
    const created = await repo.create({ projectId: PROJECT_ID, name: "Versioned" });
    expect(created.entityRevision).toBe("1");
    const renamed = await repo.update(created.id, { name: "Renamed" });
    expect(renamed.entityRevision).toBe("2");
    const archived = await repo.archive(created.id);
    expect(archived.entityRevision).toBe("3");
    expect((await repo.archive(created.id)).entityRevision).toBe("3");
    const unarchived = await repo.unarchive(created.id);
    expect(unarchived.entityRevision).toBe("4");
    await repo.softDelete(created.id);
    expect((await repo.findById(created.id))?.entityRevision).toBe("5");
    const restored = await repo.restore(created.id);
    expect(restored.entityRevision).toBe("6");
    expect((await repo.restore(created.id)).entityRevision).toBe("6");
  });
});
