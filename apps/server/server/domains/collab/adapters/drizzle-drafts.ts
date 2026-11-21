/**
 * Drizzle adapter for drafts. A draft is minted with the Work or root chat that names it (the
 * `mint_named_draft` trigger), so nothing here creates one; an owner's draft is its pointer.
 */
import type { DraftId, DraftOwner } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { drafts, threads, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { draftOfOwnerSql, draftOwnerSql, ownerOfColumns } from "../../../shared/draft-owner.js";
import { assertDraftWriteJoinAllowed } from "../../../shared/draft-write-join.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Draft, DraftStore, DraftWriteBoundary } from "../domain/ports/draft-store.js";

const draftColumns = {
  id: drafts.id,
  projectId: drafts.projectId,
  createdBy: drafts.createdBy,
  createdAt: drafts.createdAt,
};

export function createDrizzleDraftStore(db: Database): DraftStore {
  const tx = () => currentDrizzleDb(db);

  async function row(draftId: DraftId, strength?: "no key update" | "share") {
    const query = tx().select(draftColumns).from(drafts).where(eq(drafts.id, draftId));
    const [found] = await (strength ? query.for(strength) : query);
    return found ?? null;
  }

  return {
    async ofOwner(owner: DraftOwner): Promise<Draft | null> {
      if (!isUuid(owner.kind === "work" ? owner.workId : owner.rootThreadId)) return null;
      const [found] = await tx()
        .select(draftColumns)
        .from(drafts)
        .where(eq(drafts.id, draftOfOwnerSql(owner)));
      return found ?? null;
    },
    async ownerOf(draftId) {
      const owner = draftOwnerSql();
      const [found] = await tx()
        .select({
          ...draftColumns,
          workId: owner.workId,
          rootThreadId: owner.rootThreadId,
          handle: owner.handle,
        })
        .from(drafts)
        .where(eq(drafts.id, draftId));
      if (!found) return null;
      const { handle, workId, rootThreadId, ...draft } = found;
      return {
        draft,
        owner: ownerOfColumns({ projectId: draft.projectId, workId, rootThreadId }),
        handle,
      };
    },
    lock: (draftId) => row(draftId, "no key update"),
    share: (draftId) => row(draftId, "share"),
    async byIds(draftIds) {
      const ids = [...new Set(draftIds)];
      if (ids.length === 0) return [];
      return tx().select(draftColumns).from(drafts).where(inArray(drafts.id, ids));
    },
    async namedBy({ workId, lineageRootIds }) {
      const roots = lineageRootIds.filter(isUuid);
      const named = await tx()
        .select({ id: works.draftId })
        .from(works)
        .where(eq(works.id, workId))
        .union(
          tx()
            .select({ id: threads.draftId })
            .from(threads)
            .where(roots.length ? inArray(threads.id, roots) : sql`false`),
        );
      return named.flatMap((entry) => (entry.id ? [entry.id] : []));
    },
  };
}

export function createDrizzleDraftWriteBoundary(
  db: Database,
  /** Owner-first order's one owner. */
  works: Pick<WorkProjectionMutation, "lockWorks">,
): DraftWriteBoundary {
  return {
    withActiveOwnerLocked: (owner, operation, options = { requireActive: true }) => {
      assertDraftWriteJoinAllowed();
      return runInDrizzleTransaction(db, async () => {
        await works.lockWorks(
          owner.kind === "work" ? { works: [owner.workId] } : { lineages: [owner.rootThreadId] },
          options,
        );
        return operation();
      });
    },
  };
}
