/** In-memory Work drafts: the same resolver semantics over a map, for in-memory composition. */
import type { DraftId, WorkId } from "@meridian/contracts";
import type { Draft, DraftStore, DraftWriteBoundary } from "../../domain/ports/draft-store.js";

export function createInMemoryDraftStore(): DraftStore {
  const rows = new Map<DraftId, Draft>();
  const active = (draftId: DraftId) => {
    const row = rows.get(draftId);
    return row?.status === "active" ? row : null;
  };
  const byOrigin = (workId: WorkId) =>
    [...rows.values()]
      .filter((row) => row.originWorkId === workId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const activeOf = (workId: WorkId) =>
    byOrigin(workId).find((row) => row.status === "active") ?? null;
  return {
    activeForWork: async (workId) => activeOf(workId),
    // Lookup and insert with no await between them: one critical section.
    async ensureActiveLocked(input) {
      const existing = activeOf(input.workId);
      if (existing) return existing;
      const draft: Draft = {
        id: crypto.randomUUID() as DraftId,
        projectId: input.projectId,
        status: "active",
        originWorkId: input.workId,
        originThreadId: input.originThreadId,
        createdBy: input.createdBy,
        createdAt: new Date(),
      };
      rows.set(draft.id, draft);
      return draft;
    },
    lockActive: async (draftId) => active(draftId),
    shareActive: async (draftId) => active(draftId),
    async close(draftId) {
      const row = rows.get(draftId);
      if (row) rows.set(draftId, { ...row, status: "closed" });
    },
    byIds: async (draftIds) => draftIds.flatMap((id) => rows.get(id) ?? []),
    byOriginWork: async (workId) => byOrigin(workId),
  };
}

/** No Work rows in memory: every Work is active; a per-Work queue stands in for its row lock. */
export function createInMemoryDraftWriteBoundary(): DraftWriteBoundary {
  const tails = new Map<WorkId, Promise<unknown>>();
  return {
    withActiveWorkLocked(workId, operation) {
      const run = (tails.get(workId) ?? Promise.resolve()).then(operation, operation);
      const tail = run.catch(() => undefined);
      tails.set(workId, tail);
      void tail.then(() => {
        if (tails.get(workId) === tail) tails.delete(workId);
      });
      return run;
    },
  };
}
