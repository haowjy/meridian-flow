/**
 * Postgres reads and the stored decision for hand-back and Stop (`HandBackStore`): the facts the
 * pure rule decides from, the `thread_hand_backs` row that makes a replay answer what the first
 * call did, and the content of handed-back messages. Every method runs under the chat's thread lock.
 */

import type { UserMessageBlock } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDatabase } from "../../../shared/drizzle-transaction.js";
import type { HandBackScopeFacts, StopFacts, WriterRow } from "../loop/stop-rule.js";
import { userMessageBlocksFromTurn } from "../loop/user-turn-blocks.js";
import type { HandBackStore, StoredHandBack } from "./runtime-delivery.js";

export function createDrizzleHandBacks(db: DrizzleDatabase): HandBackStore {
  const db_ = () => currentDrizzleDb(db);
  const inbox = schema.threadInboxMessages;

  return {
    async find(threadId, requestId) {
      const [row] = await db_()
        .select()
        .from(schema.threadHandBacks)
        .where(eq(schema.threadHandBacks.requestId, requestId))
        .limit(1);
      if (!row) return null;
      if (row.threadId !== threadId) return null;
      return {
        fingerprint: row.fingerprint,
        handedBack: row.handedBack,
        answered: row.answered,
        gone: row.gone,
        cancelledExecutionId: row.cancelledExecutionId,
      } satisfies StoredHandBack;
    },

    async readFacts(threadId, scope): Promise<StopFacts> {
      const [lease] = await db_()
        .select({
          executionId: schema.threadRunLeases.executionId,
          receipt: schema.threadRunLeases.adoptedMessageIds,
          turnId: schema.threadRunLeases.turnId,
        })
        .from(schema.threadRunLeases)
        .where(eq(schema.threadRunLeases.threadId, threadId))
        .for("update");
      const executionTurnIds = lease
        ? (
            await db_()
              .select({ id: schema.turns.id })
              .from(schema.turns)
              .where(
                and(
                  eq(schema.turns.threadId, threadId),
                  sql`${schema.turns.executionId}::text = ${lease.executionId}`,
                ),
              )
          ).map((turn) => turn.id as string)
        : [];
      // The predicate of `readOpenExecutionId`: some turn carries the execution, expiry ignored.
      const carried = lease !== undefined && executionTurnIds.length > 0;
      const [holderRow] =
        carried && lease.turnId
          ? await db_()
              .select({ role: schema.turns.role })
              .from(schema.turns)
              .where(eq(schema.turns.id, lease.turnId))
              .limit(1)
          : [];
      const holder =
        holderRow?.role === "assistant" || holderRow?.role === "compaction" ? holderRow.role : null;

      const writer = and(
        eq(inbox.threadId, threadId),
        eq(inbox.intent, "message"),
        sql`${inbox.provenance}->>'kind' = 'writer'`,
      );
      const byExecution =
        executionTurnIds.length > 0
          ? inArray(inbox.deliveredByTurnId, executionTurnIds as TurnId[])
          : sql`FALSE`;
      let where: ReturnType<typeof and>;
      if (scope.kind === "ids") {
        where = and(writer, scope.ids.length > 0 ? inArray(inbox.id, [...scope.ids]) : sql`FALSE`);
      } else {
        // The rows the record could show (waiting), the ones the open execution answered, and the
        // press's own messages. Handed-back rows count only inside the window the writer's record
        // could still show: above the last message a reply answered.
        const [answeredFloor] = await db_()
          .select({ seq: sql<number | null>`max(${inbox.seq})` })
          .from(inbox)
          .where(
            and(
              writer,
              sql`${inbox.deliveredByTurnId} IS NOT NULL`,
              sql`${inbox.seq} <= ${scope.seenThrough}`,
            ),
          );
        const floor = Number(answeredFloor?.seq ?? 0);
        const mine = scope.mine.length > 0 ? inArray(inbox.id, [...scope.mine]) : sql`FALSE`;
        where = and(
          writer,
          sql`(${inbox.deliveredAt} IS NULL OR ${byExecution} OR ${mine}
            OR (${inbox.handedBackBy} IS NOT NULL AND ${inbox.seq} <= ${scope.seenThrough} AND ${inbox.seq} > ${floor}))`,
        );
      }
      const executionTurns = new Set(executionTurnIds);
      const rows = await db_()
        .select({
          id: inbox.id,
          seq: inbox.seq,
          deliveredAt: inbox.deliveredAt,
          deliveredByTurnId: inbox.deliveredByTurnId,
          handedBackBy: inbox.handedBackBy,
        })
        .from(inbox)
        .where(where)
        .orderBy(asc(inbox.seq));
      return {
        execution: carried ? { id: lease.executionId, holder } : null,
        receipt: lease?.receipt ?? [],
        rows: rows.map(
          (row): WriterRow => ({
            id: row.id,
            seq: row.seq,
            delivered: row.deliveredAt !== null,
            byExecution:
              row.deliveredByTurnId !== null && executionTurns.has(row.deliveredByTurnId as string),
            handedBackBy: row.handedBackBy,
          }),
        ),
      };
    },

    async record(threadId, requestId, fingerprint, decision) {
      await db_()
        .insert(schema.threadHandBacks)
        .values({
          requestId,
          threadId,
          fingerprint,
          handedBack: decision.handBack,
          answered: decision.answered,
          gone: decision.gone,
          cancelledExecutionId: decision.cancelledExecutionId ?? null,
        });
    },

    async cancelExecution(threadId: ThreadId, executionId) {
      // Matched by execution id with no expiry predicate: an expired holder's row is flagged too.
      const rows = await db_()
        .update(schema.threadRunLeases)
        .set({ cancelRequested: true })
        .where(
          and(
            eq(schema.threadRunLeases.threadId, threadId),
            eq(schema.threadRunLeases.executionId, executionId),
          ),
        )
        .returning({ threadId: schema.threadRunLeases.threadId });
      return rows.length > 0;
    },

    async contentOf(userTurnIds) {
      if (userTurnIds.length === 0) return [];
      const blocks = await db_()
        .select()
        .from(schema.turnBlocks)
        .where(inArray(schema.turnBlocks.turnId, [...userTurnIds] as TurnId[]))
        .orderBy(asc(schema.turnBlocks.sequence));
      return userTurnIds.map((userTurnId) => ({
        userTurnId,
        blocks: userMessageBlocksFromTurn(
          blocks.filter((block) => block.turnId === userTurnId),
        ) satisfies UserMessageBlock[],
      }));
    },
  };
}
