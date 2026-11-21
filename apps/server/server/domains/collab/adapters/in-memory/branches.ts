/**
 * In-memory drafts: the same resolver semantics over a map, for in-memory composition. The rows
 * that name a draft live in other in-memory stores, so the composition passes `namedDraft`, which
 * reads the draft id the owner's row carries; an owner it doesn't know names no draft.
 */
import type { DraftId, DraftOwner, ProjectId } from "@meridian/contracts";
import type { Branch, BranchStore, BranchWriteBoundary } from "../../domain/ports/branch-store.js";

/** The draft an owner's row names, with that row's project; null for an owner with no row. */
export type NamedDraft = (
  owner: DraftOwner,
) => Promise<{ id: DraftId; projectId: ProjectId } | null>;

const ownerKey = (owner: DraftOwner) =>
  owner.kind === "work" ? `work:${owner.workId}` : `lineage:${owner.rootThreadId}`;

export function createInMemoryBranchStore(namedDraft: NamedDraft): BranchStore {
  const rows = new Map<DraftId, Branch>();
  const named = new Map<string, { draftId: DraftId; owner: DraftOwner }>();
  const ownerOfDraft = (draftId: DraftId) =>
    [...named.values()].find((entry) => entry.draftId === draftId)?.owner ?? null;
  return {
    async ownerOf(draftId) {
      const branch = rows.get(draftId);
      return branch ? { branch, owner: ownerOfDraft(draftId), handle: null } : null;
    },
    async ofOwner(owner) {
      const draft = await namedDraft(owner);
      if (!draft) return null;
      const branch = rows.get(draft.id) ?? {
        id: draft.id,
        projectId: draft.projectId,
        createdBy: "",
        createdAt: new Date(),
      };
      rows.set(branch.id, branch);
      named.set(ownerKey(owner), { draftId: branch.id, owner });
      return branch;
    },
    lock: async (draftId) => rows.get(draftId) ?? null,
    share: async (draftId) => rows.get(draftId) ?? null,
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

/** No owner rows in memory: every owner is active; a per-owner queue stands in for its lock. */
export function createInMemoryBranchWriteBoundary(): BranchWriteBoundary {
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
