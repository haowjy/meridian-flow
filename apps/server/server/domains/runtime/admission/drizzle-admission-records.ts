/** PostgreSQL admission ledger, enlisted in the ambient serialized turn transaction. */
import type { AcceptedAdmission, RetireAdmissionResult } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { threads, turns, userTurnAdmissions } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb } from "../../threads/adapters/drizzle/repositories.js";
import type { AdmissionRecord, AdmissionRecordPort } from "./user-turn-admission.js";

function map(row: typeof userTurnAdmissions.$inferSelect): AdmissionRecord {
  if (row.state === "accepted") {
    if (
      !row.fingerprint ||
      !row.userTurnId ||
      !row.assistantTurnId ||
      row.resumeAfterSeq === null ||
      row.snapshotFloorNextSeq === null
    ) {
      throw new Error("Accepted admission row is incomplete");
    }
    return {
      state: "accepted",
      fingerprint: row.fingerprint,
      response: {
        kind: "accepted",
        threadId: row.threadId,
        submissionId: row.submissionId,
        userTurnId: row.userTurnId,
        assistantTurnId: row.assistantTurnId,
        resumeAfterSeq: row.resumeAfterSeq,
        snapshotFloorNextSeq: row.snapshotFloorNextSeq,
      },
    };
  }
  if (row.state === "pending") {
    if (!row.fingerprint) throw new Error("Pending admission row is missing fingerprint");
    return { state: "pending", fingerprint: row.fingerprint };
  }
  return {
    state: row.state as "rejected" | "retired",
    fingerprint: row.fingerprint,
    code: row.rejectionCode ?? row.state,
  };
}

export interface AdmissionPersistencePort extends AdmissionRecordPort {
  accept(input: {
    response: AcceptedAdmission;
    fingerprint: string;
  }): Promise<
    { kind: "accepted"; response: AcceptedAdmission } | { kind: "winner"; record: AdmissionRecord }
  >;
  recoverExpiredPending(input: {
    threadId: string;
    submissionId: string;
    now: Date;
    hasLiveClaim(threadId: string): Promise<boolean>;
  }): Promise<AdmissionRecord | null>;
}

export function createDrizzleAdmissionRecords(db: Database): AdmissionPersistencePort {
  const read = async (threadId: string, submissionId: string) => {
    const [row] = await currentDrizzleDb(db)
      .select()
      .from(userTurnAdmissions)
      .where(
        and(
          eq(userTurnAdmissions.threadId, threadId as never),
          eq(userTurnAdmissions.submissionId, submissionId),
        ),
      )
      .limit(1);
    return row ? map(row) : null;
  };
  return {
    lookup: read,
    async reserve(input) {
      return runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, input.threadId as never))
          .for("update");
        const existing = await read(input.threadId, input.submissionId);
        if (existing) return { kind: "winner", record: existing };
        await currentDrizzleDb(db)
          .insert(userTurnAdmissions)
          .values({
            threadId: input.threadId as never,
            submissionId: input.submissionId,
            actorUserId: input.actorUserId as never,
            fingerprint: input.fingerprint,
            state: "pending",
            claimExpiresAt: input.claimExpiresAt,
          });
        return { kind: "reserved" };
      });
    },
    async reject(input) {
      return runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, input.threadId as never))
          .for("update");
        const [row] = await currentDrizzleDb(db)
          .select()
          .from(userTurnAdmissions)
          .where(
            and(
              eq(userTurnAdmissions.threadId, input.threadId as never),
              eq(userTurnAdmissions.submissionId, input.submissionId),
            ),
          )
          .for("update");
        if (!row) throw new Error("Reserved admission disappeared before rejection");
        if (row.state !== "pending" || row.fingerprint !== input.fingerprint) return map(row);
        const [rejected] = await currentDrizzleDb(db)
          .update(userTurnAdmissions)
          .set({
            state: "rejected",
            rejectionCode: input.code,
            claimExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(userTurnAdmissions.threadId, input.threadId as never),
              eq(userTurnAdmissions.submissionId, input.submissionId),
            ),
          )
          .returning();
        if (!rejected) throw new Error("Reserved admission disappeared during rejection");
        return map(rejected);
      });
    },
    async recoverExpiredPending(input) {
      return runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, input.threadId as never))
          .for("update");
        const [row] = await currentDrizzleDb(db)
          .select()
          .from(userTurnAdmissions)
          .where(
            and(
              eq(userTurnAdmissions.threadId, input.threadId as never),
              eq(userTurnAdmissions.submissionId, input.submissionId),
            ),
          )
          .for("update");
        if (row?.state !== "pending" || !row.claimExpiresAt) return row ? map(row) : null;
        if (row.claimExpiresAt > input.now || (await input.hasLiveClaim(input.threadId))) {
          return map(row);
        }
        const turnIds = [row.userTurnId, row.assistantTurnId].filter(
          (id): id is NonNullable<typeof id> => id !== null,
        );
        if (turnIds.length > 0) {
          const committed = await currentDrizzleDb(db)
            .select({ id: turns.id })
            .from(turns)
            .where(inArray(turns.id, turnIds));
          if (committed.length > 0) return map(row);
        }
        const [rejected] = await currentDrizzleDb(db)
          .update(userTurnAdmissions)
          .set({
            state: "rejected",
            rejectionCode: "recovery_no_committed_turn",
            claimExpiresAt: null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(userTurnAdmissions.threadId, input.threadId as never),
              eq(userTurnAdmissions.submissionId, input.submissionId),
            ),
          )
          .returning();
        if (!rejected) throw new Error("Expired pending admission disappeared during recovery");
        return map(rejected);
      });
    },
    async accept(input) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(userTurnAdmissions)
        .where(
          and(
            eq(userTurnAdmissions.threadId, input.response.threadId),
            eq(userTurnAdmissions.submissionId, input.response.submissionId),
          ),
        )
        .for("update");
      if (!row) throw new Error("Admission was not reserved before acceptance");
      if (row.state !== "pending" || row.fingerprint !== input.fingerprint) {
        return { kind: "winner", record: map(row) };
      }
      const [accepted] = await currentDrizzleDb(db)
        .update(userTurnAdmissions)
        .set({
          state: "accepted",
          userTurnId: input.response.userTurnId,
          assistantTurnId: input.response.assistantTurnId,
          resumeAfterSeq: input.response.resumeAfterSeq,
          snapshotFloorNextSeq: input.response.snapshotFloorNextSeq,
          claimExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userTurnAdmissions.threadId, input.response.threadId),
            eq(userTurnAdmissions.submissionId, input.response.submissionId),
          ),
        )
        .returning();
      if (!accepted) throw new Error("Reserved admission disappeared during acceptance");
      return { kind: "accepted", response: input.response };
    },
    async retire(request): Promise<RetireAdmissionResult> {
      return runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, request.threadId))
          .for("update");
        const existing = await read(request.threadId, request.submissionId);
        if (existing?.state === "accepted")
          return { ...existing.response, kind: "already-accepted" };
        if (existing?.state === "pending")
          return { kind: "pending", submissionId: request.submissionId };
        if (existing?.state === "rejected")
          return { kind: "rejected", submissionId: request.submissionId, code: existing.code };
        if (!existing) {
          await currentDrizzleDb(db).insert(userTurnAdmissions).values({
            threadId: request.threadId,
            submissionId: request.submissionId,
            actorUserId: request.actorUserId,
            fingerprint: null,
            state: "retired",
            rejectionCode: "retired",
          });
        }
        return { kind: "retired", submissionId: request.submissionId, code: "retired" };
      });
    },
  };
}
