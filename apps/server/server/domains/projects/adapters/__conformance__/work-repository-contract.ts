/** Shared lifecycle behavior required of every WorkRepository adapter. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { expect } from "vitest";
import { type WorkRepository, WorkRestoreExpiredError } from "../../ports/work-repository.js";

export type WorkRepositoryConformanceHarness = {
  repo: WorkRepository;
  projectId: string;
  setNow(now: Date): void;
  addThread(input: { id: ThreadId; workId: WorkId; deletedAt: string | null }): Promise<void>;
  readThread(id: ThreadId): Promise<{
    deletedAt: string | null;
    deletedByWorkId: WorkId | null;
  }>;
};

const LIVE_THREAD_ID = "00000000-0000-4000-8000-000000000a01" as ThreadId;
const TRASHED_THREAD_ID = "00000000-0000-4000-8000-000000000a02" as ThreadId;

export async function expectWorkRepositoryLifecycleContract(
  harness: WorkRepositoryConformanceHarness,
): Promise<void> {
  harness.setNow(new Date("2026-01-01T00:00:00.000Z"));
  const work = await harness.repo.create({ projectId: harness.projectId, name: "Lifecycle" });
  await harness.addThread({ id: LIVE_THREAD_ID, workId: work.id, deletedAt: null });
  await harness.addThread({
    id: TRASHED_THREAD_ID,
    workId: work.id,
    deletedAt: "2025-12-01T00:00:00.000Z",
  });

  const deletion = await harness.repo.softDelete(work.id);
  expect(deletion.threadIds).toEqual([LIVE_THREAD_ID]);
  await expect(harness.readThread(LIVE_THREAD_ID)).resolves.toMatchObject({
    deletedAt: "2026-01-01T00:00:00.000Z",
    deletedByWorkId: work.id,
  });
  await expect(harness.readThread(TRASHED_THREAD_ID)).resolves.toEqual({
    deletedAt: "2025-12-01T00:00:00.000Z",
    deletedByWorkId: null,
  });

  const restored = await harness.repo.restore(work.id);
  expect(restored.changed).toBe(true);
  await expect(harness.readThread(LIVE_THREAD_ID)).resolves.toEqual({
    deletedAt: null,
    deletedByWorkId: null,
  });
  await expect(harness.readThread(TRASHED_THREAD_ID)).resolves.toEqual({
    deletedAt: "2025-12-01T00:00:00.000Z",
    deletedByWorkId: null,
  });
  await expect(harness.repo.restore(work.id)).resolves.toMatchObject({ changed: false });

  await harness.repo.softDelete(work.id);
  harness.setNow(new Date("2026-01-31T00:00:00.000Z"));
  await expect(harness.repo.restore(work.id)).rejects.toBeInstanceOf(WorkRestoreExpiredError);
}
