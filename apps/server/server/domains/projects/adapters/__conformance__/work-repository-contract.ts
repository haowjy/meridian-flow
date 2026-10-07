/** Shared lifecycle policy required of every WorkRepository adapter. */
import { expect } from "vitest";
import { type WorkRepository, WorkRestoreExpiredError } from "../../ports/work-repository.js";

export type WorkRepositoryConformanceHarness = {
  repo: WorkRepository;
  projectId: string;
  setNow(now: Date): void;
};

export async function expectWorkRepositoryLifecycleContract(
  harness: WorkRepositoryConformanceHarness,
): Promise<void> {
  harness.setNow(new Date("2026-01-01T00:00:00.000Z"));
  // Callers normalize metadata with the shared Work rule; the adapter stores it as given.
  const work = await harness.repo.create({
    projectId: harness.projectId,
    name: "Lifecycle",
    goal: null,
  });
  expect(work).toMatchObject({ name: "Lifecycle", goal: null });
  await expect(harness.repo.update(work.id, { goal: "Reach the mirror" })).resolves.toMatchObject({
    goal: "Reach the mirror",
  });
  await expect(harness.repo.update(work.id, { goal: null })).resolves.toMatchObject({
    goal: null,
  });

  const deletion = await harness.repo.softDelete(work.id);
  expect(deletion.after?.deletedAt).toBe("2026-01-01T00:00:00.000Z");

  const restored = await harness.repo.restore(work.id);
  expect(restored.changed).toBe(true);
  expect(restored.after.deletedAt).toBeNull();
  await expect(harness.repo.restore(work.id)).resolves.toMatchObject({ changed: false });

  await harness.repo.softDelete(work.id);
  harness.setNow(new Date("2026-01-31T00:00:00.000Z"));
  await expect(harness.repo.restore(work.id)).rejects.toBeInstanceOf(WorkRestoreExpiredError);
}
