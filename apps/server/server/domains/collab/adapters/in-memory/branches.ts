/**
 * In-memory drafts: the same resolver semantics over a map, for in-memory composition. There are
 * no Work or chat rows here to name a draft, so an owner's draft is minted the first time it is
 * asked for, under the owner's key.
 */
import { type DraftId, type DraftOwner, newDraftId } from "@meridian/contracts";
import type { Branch, BranchStore, BranchWriteBoundary } from "../../domain/ports/branch-store.js";

const ownerKey = (owner: DraftOwner) =>
  owner.kind === "work" ? `work:${owner.workId}` : `lineage:${owner.rootThreadId}`;

export function createInMemoryBranchStore(): BranchStore {
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
      const existing = named.get(ownerKey(owner));
      if (existing) return rows.get(existing.draftId) ?? null;
      const branch: Branch = {
        id: newDraftId(),
        projectId: owner.kind === "lineage" ? owner.projectId : "",
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
    async delete(draftIds) {
      for (const id of draftIds) rows.delete(id);
      for (const [key, entry] of named) if (draftIds.includes(entry.draftId)) named.delete(key);
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
