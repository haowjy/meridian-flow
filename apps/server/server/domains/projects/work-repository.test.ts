/** WorkRepository lifecycle and D17 deletion contract at the domain port boundary. */
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import {
  WorkDeleteBlockedError,
  WorkNameConflictError,
  WorkRestoreConflictError,
} from "./ports/work-repository.js";

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

  it("assigns stable, deduplicated slugs and uses a deterministic symbols-only fallback", async () => {
    const repo = createInMemoryWorkRepository();
    const first = await repo.create({ projectId: PROJECT_ID, name: "Book 2!" });
    const second = await repo.create({ projectId: PROJECT_ID, name: "Book 2?" });
    const symbols = await repo.create({ projectId: PROJECT_ID, name: "!!!" });

    expect([first.slug, second.slug, symbols.slug]).toEqual(["book-2", "book-2-2", "work"]);
    await expect(repo.update(first.id, { name: "Renamed" })).resolves.toMatchObject({
      name: "Renamed",
      slug: "book-2",
    });
  });

  it("restores a deleted Work when its name and slug remain available", async () => {
    const repo = createInMemoryWorkRepository();
    const created = await repo.create({ projectId: PROJECT_ID, name: "Restorable" });
    await repo.softDelete(created.id);

    await expect(repo.restore(created.id)).resolves.toMatchObject({
      id: created.id,
      slug: "restorable",
      deletedAt: null,
    });
  });

  it("refuses restore when the deleted Work's name or slug was reclaimed", async () => {
    const nameRepo = createInMemoryWorkRepository();
    const nameOwner = await nameRepo.create({ projectId: PROJECT_ID, name: "Reclaimed" });
    await nameRepo.softDelete(nameOwner.id);
    await nameRepo.create({ projectId: PROJECT_ID, name: "Reclaimed" });
    await expect(nameRepo.restore(nameOwner.id)).rejects.toEqual(
      new WorkRestoreConflictError("name"),
    );

    const slugRepo = createInMemoryWorkRepository();
    const slugOwner = await slugRepo.create({ projectId: PROJECT_ID, name: "Book 2!" });
    await slugRepo.softDelete(slugOwner.id);
    await slugRepo.create({ projectId: PROJECT_ID, name: "Book 2?" });
    await expect(slugRepo.restore(slugOwner.id)).rejects.toEqual(
      new WorkRestoreConflictError("slug"),
    );
  });
});
