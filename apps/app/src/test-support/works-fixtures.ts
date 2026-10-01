/** Shared Work fixtures for projection and component tests. */
import type { Work, WorksSnapshot } from "@meridian/contracts/works";

export const WORK = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "project-1",
  createdByUserId: "user-1",
  name: "Arc",
  slug: "arc",
  isNoWork: false,
  goal: null,
  status: null,
  archivedAt: null,
  aiWriteMode: "direct",
  entityRevision: "1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
} as Work;

export const snapshot = (works: Work[], authorityRevision = "1") =>
  ({
    projectId: WORK.projectId,
    catalogGeneration: "1",
    authorityRevision,
    requestId: `request-${authorityRevision}`,
    works,
    noWork: { ...WORK, id: "no-work", name: "No Work", isNoWork: true, slug: null },
  }) as unknown as WorksSnapshot;

export const archived = (work: Work): Work => ({
  ...work,
  archivedAt: "2026-09-02T00:00:00.000Z",
});

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
