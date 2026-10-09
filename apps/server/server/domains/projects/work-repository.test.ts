/** WorkRepository lifecycle and D17 deletion contract at the domain port boundary. */
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { WorkLockedError } from "./ports/work-repository.js";

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
});

describe("No Work", () => {
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
