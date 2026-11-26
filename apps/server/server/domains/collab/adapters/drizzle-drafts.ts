import type { DraftOwner } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { drafts, threads } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { draftOfOwnerSql, draftOwnerSql, ownerOfColumns } from "../../../shared/draft-owner.js";
import { assertDraftWriteJoinAllowed } from "../../../shared/draft-write-join.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Draft, DraftStore, DraftWriteBoundary } from "../domain/ports/draft-store.js";

const draftColumns = {
  id: drafts.id,
  projectId: drafts.projectId,
  workId: drafts.workId,
  deletedAt: drafts.deletedAt,
  createdBy: drafts.createdBy,
  createdAt: drafts.createdAt,
};

export function createDrizzleDraftStore(db: Database): DraftStore {
  const tx = () => currentDrizzleDb(db);

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
          ownerWorkId: owner.workId,
          ownerRootThreadId: owner.rootThreadId,
          handle: owner.handle,
        })
        .from(drafts)
        .where(eq(drafts.id, draftId));
      if (!found) return null;
      const { handle, ownerWorkId, ownerRootThreadId, ...draft } = found;
      return {
        draft,
        owner: ownerOfColumns({
          projectId: draft.projectId,
          workId: ownerWorkId,
          rootThreadId: ownerRootThreadId,
        }),
        handle,
      };
    },
    async lock(draftId) {
      const [found] = await tx()
        .select(draftColumns)
        .from(drafts)
        .where(eq(drafts.id, draftId))
        .for("no key update");
      return found ?? null;
    },
    async byIds(draftIds) {
      const ids = [...new Set(draftIds)];
      if (ids.length === 0) return [];
      return tx().select(draftColumns).from(drafts).where(inArray(drafts.id, ids));
    },
    async namedBy({ workId, lineageRootIds }) {
      const roots = lineageRootIds.filter(isUuid);
      const named = await tx()
        .select({ id: drafts.id })
        .from(drafts)
        .where(eq(drafts.workId, workId))
        .union(
          tx()
            .select({ id: drafts.id })
            .from(threads)
            .innerJoin(drafts, eq(drafts.id, threads.draftId))
            .where(
              roots.length ? and(inArray(threads.id, roots), isNull(drafts.workId)) : sql`false`,
            ),
        );
      return named.flatMap((entry) => (entry.id ? [entry.id] : []));
    },
  };
}

export function createDrizzleDraftWriteBoundary(
  db: Database,
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
