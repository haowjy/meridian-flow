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
  const activeForWork = async (workId: WorkId) =>
    byOrigin(workId).find((row) => row.status === "active") ?? null;
  return {
    activeForWork,
    async ensureActiveLocked(input) {
      const existing = await activeForWork(input.workId);
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

/** No Work rows in memory: every Work is active and writes never interleave. */
export const inMemoryDraftWriteBoundary: DraftWriteBoundary = {
  withActiveWorkLocked: (_workId, operation) => operation(),
};
