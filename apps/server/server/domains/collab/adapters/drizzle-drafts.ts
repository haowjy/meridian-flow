/**
 * Drizzle adapter for Work drafts. "One active draft per Work" is written in exactly two
 * statements here: `activeForWork`'s select and `ensureActiveLocked`'s insert-if-absent,
 * race-free because every caller holds the Work row lock.
 */
import type { DraftId, WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { drafts } from "@meridian/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { assertDraftWriteJoinAllowed } from "../../../shared/draft-write-join.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { lockWorksInIdOrder } from "../../../shared/work-lifecycle-lock.js";
import { dropDraftSettlements } from "../../context/adapters/link-ahead-draft-settlements.js";
import { WorkLifecycleUnavailableError } from "../../projects/domain/work-lifecycle.js";
import type { Draft, DraftStore, DraftWriteBoundary } from "../domain/ports/draft-store.js";

const draftColumns = {
  id: drafts.id,
  projectId: drafts.projectId,
  status: drafts.status,
  originWorkId: drafts.originWorkId,
  originThreadId: drafts.originThreadId,
  createdBy: drafts.createdBy,
  createdAt: drafts.createdAt,
};

export function createDrizzleDraftStore(db: Database): DraftStore {
  const tx = () => currentDrizzleDb(db);

  async function activeForWork(workId: WorkId): Promise<Draft | null> {
    if (!isUuid(workId)) return null;
    const [row] = await tx()
      .select(draftColumns)
      .from(drafts)
      .where(and(eq(drafts.originWorkId, workId), eq(drafts.status, "active")))
      .orderBy(asc(drafts.createdAt), asc(drafts.id))
      .limit(1);
    return row ?? null;
  }

  async function activeRow(draftId: DraftId, strength: "no key update" | "share") {
    if (!isUuid(draftId)) return null;
    const [row] = await tx()
      .select(draftColumns)
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.status, "active")))
      .for(strength);
    return row ?? null;
  }

  return {
    activeForWork,
    async ensureActiveLocked(input) {
      const existing = await activeForWork(input.workId);
      if (existing) return existing;
      const [created] = await tx()
        .insert(drafts)
        .values({
          projectId: input.projectId,
          originWorkId: input.workId,
          originThreadId: input.originThreadId,
          createdBy: input.createdBy,
        })
        .returning(draftColumns);
      if (!created) throw new Error(`Draft insert for Work ${input.workId} returned no row`);
      return created;
    },
    lockActive: (draftId) => activeRow(draftId, "no key update"),
    shareActive: (draftId) => activeRow(draftId, "share"),
    async close(draftId, at) {
      await tx()
        .update(drafts)
        .set({ status: "closed", closedAt: at })
        .where(and(eq(drafts.id, draftId), eq(drafts.status, "active")));
      await dropDraftSettlements(db, { draftId });
    },
    async byIds(draftIds) {
      const ids = [...new Set(draftIds)].filter(isUuid);
      if (ids.length === 0) return [];
      return tx().select(draftColumns).from(drafts).where(inArray(drafts.id, ids));
    },
    async byOriginWork(workId) {
      if (!isUuid(workId)) return [];
      return tx()
        .select(draftColumns)
        .from(drafts)
        .where(eq(drafts.originWorkId, workId))
        .orderBy(asc(drafts.createdAt), asc(drafts.id));
    },
  };
}

export function createDrizzleDraftWriteBoundary(db: Database): DraftWriteBoundary {
  return {
    withActiveWorkLocked: (workId, operation) => {
      assertDraftWriteJoinAllowed();
      return runInDrizzleTransaction(db, async () => {
        const work = (await lockWorksInIdOrder(db, [workId])).get(workId) ?? {
          state: "missing" as const,
          slug: null,
        };
        if (work.state !== "active") {
          throw new WorkLifecycleUnavailableError(workId, work.state, work.slug);
        }
        return operation();
      });
    },
  };
}
