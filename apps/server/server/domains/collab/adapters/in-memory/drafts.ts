import type { DraftId, DraftOwner, ProjectId } from "@meridian/contracts";
import type { Draft, DraftStore, DraftWriteBoundary } from "../../domain/ports/draft-store.js";

export type NamedDraft = (
  owner: DraftOwner,
) => Promise<{ id: DraftId; projectId: ProjectId } | null>;

const ownerKey = (owner: DraftOwner) =>
  owner.kind === "work" ? `work:${owner.workId}` : `lineage:${owner.rootThreadId}`;

export function createInMemoryDraftStore(namedDraft: NamedDraft): DraftStore {
  const rows = new Map<DraftId, Draft>();
  const named = new Map<string, { draftId: DraftId; owner: DraftOwner }>();
  const ownerOfDraft = (draftId: DraftId) =>
    [...named.values()].find((entry) => entry.draftId === draftId)?.owner ?? null;
  return {
    async ownerOf(draftId) {
      const row = rows.get(draftId);
      return row ? { draft: row, owner: ownerOfDraft(draftId), handle: null } : null;
    },
    async ofOwner(owner) {
      const draft = await namedDraft(owner);
      if (!draft) return null;
      const row = rows.get(draft.id) ?? {
        id: draft.id,
        projectId: draft.projectId,
        workId: owner.kind === "work" ? owner.workId : null,
        deletedAt: null,
        createdBy: "",
        createdAt: new Date(),
      };
      rows.set(row.id, row);
      named.set(ownerKey(owner), { draftId: row.id, owner });
      return row;
    },
    lock: async (draftId) => rows.get(draftId) ?? null,
    byIds: async (draftIds) => draftIds.flatMap((id) => rows.get(id) ?? []),
    async namedBy({ workId, lineageRootIds }) {
      return [...named.values()]
        .filter(({ owner }) =>
          owner.kind === "work"
            ? owner.workId === workId
            : lineageRootIds.includes(owner.rootThreadId),
        )
        .map((entry) => entry.draftId);
    },
  };
}

export function createInMemoryDraftWriteBoundary(): DraftWriteBoundary {
  const tails = new Map<string, Promise<unknown>>();
  return {
    withActiveOwnerLocked(owner, operation) {
      const key = ownerKey(owner);
      const run = (tails.get(key) ?? Promise.resolve()).then(operation, operation);
      const tail = run.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    },
  };
}
