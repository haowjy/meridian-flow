/**
 * Joins a durable document admission to every pending settlement outbox for that
 * document. The caller holds the document admission lock in its transaction;
 * each novel source advances the outbox join version exactly once.
 */
import type { Database } from "@meridian/database";
import {
  branchPushOutboxUpdates,
  branchPushSettlementBatches,
  branchPushSettlementOutbox,
} from "@meridian/database/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { SettlementAdmission } from "../domain/ports/pending-settlement-store.js";

export async function joinAdmissionWithinTx(
  db: Pick<Database, "select" | "insert" | "update">,
  input: SettlementAdmission,
): Promise<number> {
  const sourceId = Number(input.source.id);
  if (!Number.isSafeInteger(sourceId)) {
    throw new Error(`Settlement admission source id is not a safe integer: ${input.source.id}`);
  }
  const excludePushId = input.excludePushId === undefined ? undefined : Number(input.excludePushId);
  if (excludePushId !== undefined && !Number.isSafeInteger(excludePushId)) {
    throw new Error(`Excluded settlement push id is not a safe integer: ${input.excludePushId}`);
  }
  const targets = await db
    .select({
      pushId: branchPushSettlementOutbox.pushId,
      ordinal: branchPushSettlementOutbox.joinVersion,
    })
    .from(branchPushSettlementOutbox)
    .innerJoin(
      branchPushSettlementBatches,
      eq(branchPushSettlementBatches.id, branchPushSettlementOutbox.batchId),
    )
    .where(
      and(
        eq(branchPushSettlementOutbox.documentId, input.documentId),
        inArray(branchPushSettlementBatches.state, ["pending", "blocked"]),
        excludePushId === undefined
          ? undefined
          : ne(branchPushSettlementOutbox.pushId, excludePushId),
      ),
    );
  let joined = 0;
  for (const target of targets) {
    const inserted = await db
      .insert(branchPushOutboxUpdates)
      .values({
        pushId: target.pushId,
        ordinal: target.ordinal,
        sourceKind: input.source.kind,
        sourceId,
        update: Buffer.from(input.update),
      })
      .onConflictDoNothing()
      .returning({ pushId: branchPushOutboxUpdates.pushId });
    if (inserted.length === 0) continue;
    await db
      .update(branchPushSettlementOutbox)
      .set({
        joinVersion: sql`${branchPushSettlementOutbox.joinVersion} + 1`,
        // App-clock → DB-clock convergence for journal admissions is deliberate (2026-07-24 divergence decision).
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(branchPushSettlementOutbox.pushId, target.pushId));
    joined += 1;
  }
  return joined;
}
