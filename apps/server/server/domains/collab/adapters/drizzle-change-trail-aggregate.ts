/** Drizzle persistence and terminal reconciliation for change-trail aggregates. */
import { createHash } from "node:crypto";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  changeTrailDeliveryOutbox,
  changeTrailDocumentDetails,
  changeTrailDocumentOccurrences,
  changeTrailShells,
  pushLineage,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type {
  ChangeTrailPersistence,
  CommittedChangeTrailProjection,
} from "../domain/ports/change-trail-persistence.js";
import type { DocumentLinkScopes } from "../domain/ports/document-link-scope.js";
import { canonicalTrailOwners, createDrizzleTrailProjection } from "./drizzle-trail-projection.js";

export type ChangeTrailAggregateWriter = ChangeTrailPersistence & {
  reconcileTerminalOwners(): Promise<void>;
};

import type { NormalizedTrail, TrailChangeV1 } from "../domain/trail-read-kernel.js";
import { wordDeltaBetweenHashlines } from "../domain/word-count.js";

function trailWordDelta(changes: readonly TrailChangeV1[]) {
  return changes.reduce(
    (total, change) => {
      const delta = wordDeltaBetweenHashlines(change.beforeText, change.afterTextAtReceipt);
      return {
        wordsAdded: total.wordsAdded + delta.wordsAdded,
        wordsRemoved: total.wordsRemoved + delta.wordsRemoved,
      };
    },
    { wordsAdded: 0, wordsRemoved: 0 },
  );
}

function deterministicUuid(namespace: string): string {
  const bytes = Buffer.from(createHash("sha256").update(namespace).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function trailIdForOwner(owner: NormalizedTrail["owner"]): string {
  return deterministicUuid(
    owner.kind === "turn"
      ? `change-trail:turn:${owner.threadId}:${owner.turnId}`
      : `change-trail:shared:${owner.threadId}`,
  );
}

export function createDrizzleChangeTrailAggregateWriter(
  db: Database,
  links?: DocumentLinkScopes,
): ChangeTrailAggregateWriter {
  const project = createDrizzleTrailProjection(db, links);
  let cursor: { thread_id: string; turn_key: string } | undefined;
  const writer: ChangeTrailAggregateWriter = {
    async record(input) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        const committed: CommittedChangeTrailProjection[] = [];
        const trails = [...input.trails].sort((left, right) =>
          trailIdForOwner(left.owner).localeCompare(trailIdForOwner(right.owner)),
        );
        // Every transaction acquires aggregate locks in trail-id order. This is
        // shared with reconciliation, which can touch turn and shared trails at once.
        for (const trail of trails) {
          const trailId = trailIdForOwner(trail.owner);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trailId}))`);
        }
        for (const trail of trails) {
          const trailId = trailIdForOwner(trail.owner);
          const [existingShell] = await tx
            .select({ version: changeTrailShells.version })
            .from(changeTrailShells)
            .where(eq(changeTrailShells.id, trailId))
            .limit(1);
          const version = (existingShell?.version ?? 0) + 1;
          await tx
            .insert(changeTrailShells)
            .values({
              id: trailId,
              threadId: trail.owner.threadId as ThreadId,
              turnId: trail.owner.kind === "turn" ? (trail.owner.turnId as TurnId) : null,
              ownerKind: trail.owner.kind,
              version,
              changeCount: trail.counts.changes,
              documentCount: trail.counts.documents,
            })
            .onConflictDoNothing();

          const existingDetails = await tx
            .select({
              documentId: changeTrailDocumentDetails.documentId,
              documentTitle: changeTrailDocumentDetails.documentTitle,
              changes: changeTrailDocumentDetails.changes,
            })
            .from(changeTrailDocumentDetails)
            .where(eq(changeTrailDocumentDetails.trailId, trailId));
          const changes = trail.changes;

          const pushIds = [
            ...new Set(
              changes.flatMap((change) =>
                change.pushId !== null && /^\d+$/.test(change.pushId)
                  ? [Number(change.pushId)]
                  : [],
              ),
            ),
          ];
          const admitters =
            pushIds.length === 0
              ? []
              : await tx
                  .select({ id: pushLineage.id, pushedByUserId: pushLineage.pushedByUserId })
                  .from(pushLineage)
                  .where(inArray(pushLineage.id, pushIds));
          const admitterByPushId = new Map(
            admitters.map((row) => [String(row.id), row.pushedByUserId ?? null]),
          );
          const documentIds = new Set([
            ...existingDetails.map((detail) => detail.documentId),
            ...trail.changes.flatMap((change) => (change.documentId ? [change.documentId] : [])),
          ]);
          for (const documentId of documentIds) {
            const documentTitle =
              input.documentTitles.get(documentId) ??
              existingDetails.find((detail) => detail.documentId === documentId)?.documentTitle ??
              "Untitled document";
            const [occurrence] = await tx
              .insert(changeTrailDocumentOccurrences)
              .values({ trailId, documentId, projectionRevision: 1 })
              .onConflictDoUpdate({
                target: [
                  changeTrailDocumentOccurrences.trailId,
                  changeTrailDocumentOccurrences.documentId,
                ],
                set: {
                  projectionRevision: sql`${changeTrailDocumentOccurrences.projectionRevision} + 1`,
                },
              })
              .returning({
                projectionRevision: changeTrailDocumentOccurrences.projectionRevision,
              });
            if (!occurrence) throw new Error("Failed to advance change-trail projection revision");
            const documentChanges = changes.filter((change) => change.documentId === documentId);
            committed.push({
              trailId,
              owner: trail.owner,
              documentId,
              projectionRevision: occurrence.projectionRevision,
              changes: documentChanges.map((change) => ({
                ...change,
                admittedByUserId:
                  change.pushId === null ? null : (admitterByPushId.get(change.pushId) ?? null),
              })),
            });
            if (documentChanges.length === 0) {
              await tx
                .delete(changeTrailDocumentDetails)
                .where(
                  and(
                    eq(changeTrailDocumentDetails.trailId, trailId),
                    eq(changeTrailDocumentDetails.documentId, documentId),
                  ),
                );
              continue;
            }
            const wordDelta = trailWordDelta(documentChanges);
            await tx
              .insert(changeTrailDocumentDetails)
              .values({
                trailId,
                documentId,
                documentTitle,
                ...wordDelta,
                changes: documentChanges,
              })
              .onConflictDoUpdate({
                target: [changeTrailDocumentDetails.trailId, changeTrailDocumentDetails.documentId],
                set: {
                  documentTitle,
                  ...wordDelta,
                  changes: documentChanges,
                  updatedAt: new Date(),
                },
              });
          }

          const details = await tx
            .select({
              documentId: changeTrailDocumentDetails.documentId,
              documentTitle: changeTrailDocumentDetails.documentTitle,
              wordsAdded: changeTrailDocumentDetails.wordsAdded,
              wordsRemoved: changeTrailDocumentDetails.wordsRemoved,
              changes: changeTrailDocumentDetails.changes,
            })
            .from(changeTrailDocumentDetails)
            .where(eq(changeTrailDocumentDetails.trailId, trailId));
          const allChanges = details.flatMap((detail) => detail.changes as TrailChangeV1[]);
          const documents = details
            .map((detail) => ({ documentId: detail.documentId, title: detail.documentTitle }))
            .sort((left, right) => left.documentId.localeCompare(right.documentId));
          const hasWordData = details.every(
            (detail) => detail.wordsAdded !== null && detail.wordsRemoved !== null,
          );
          await tx
            .update(changeTrailShells)
            .set({
              version,
              state: "building",
              settledAt: null,
              changeCount: allChanges.length,
              documentCount: details.length,
              documents,
              wordsAdded: hasWordData
                ? details.reduce((sum, detail) => sum + (detail.wordsAdded ?? 0), 0)
                : null,
              wordsRemoved: hasWordData
                ? details.reduce((sum, detail) => sum + (detail.wordsRemoved ?? 0), 0)
                : null,
              updatedAt: new Date(),
            })
            .where(eq(changeTrailShells.id, trailId));
          const counts = {
            changeCount: allChanges.length,
            documentCount: details.length,
          };
          await tx.insert(changeTrailDeliveryOutbox).values({
            eventId: deterministicUuid(`change-trail-event:${trailId}:${version}:updated`),
            threadId: trail.owner.threadId as ThreadId,
            trailId,
            version,
            eventKind: "updated",
            ...counts,
          });
        }
        return committed;
      });
    },
    async reconcileTerminalOwners() {
      const result = await reconcileTerminalOwners(db, writer, project, cursor);
      cursor = result.cursor;
      if (result.failures.length)
        throw new AggregateError(result.failures, "Change trail projection failed");
    },
  };
  return writer;
}

async function reconcileTerminalOwners(
  db: Database,
  writer: ChangeTrailAggregateWriter,
  project: ReturnType<typeof createDrizzleTrailProjection>,
  cursor?: { thread_id: string; turn_key: string },
) {
  const page = (after: typeof cursor) =>
    db.execute<{ thread_id: string; turn_id: string | null; turn_key: string }>(sql`
    SELECT thread_id, turn_id, coalesce(turn_id, '00000000-0000-0000-0000-000000000000'::uuid) AS turn_key FROM (
      SELECT thread_id, turn_id FROM change_trail_dirty_log
      UNION SELECT thread_id, turn_id FROM change_trail_shells WHERE state <> 'settled'
      UNION SELECT thread_id, id FROM turns WHERE status IN ('complete','cancelled','error') AND NOT EXISTS (
        SELECT 1 FROM change_trail_shells shell WHERE shell.turn_id = turns.id AND shell.thread_id = turns.thread_id
      ) AND EXISTS (SELECT 1 FROM threads WHERE threads.id = turns.thread_id AND threads.kind = 'primary')
    ) candidates
    ${after ? sql`WHERE (thread_id, coalesce(turn_id, '00000000-0000-0000-0000-000000000000'::uuid)) > (${after.thread_id}::uuid, ${after.turn_key}::uuid)` : sql``}
    ORDER BY thread_id, turn_key LIMIT 100
  `);
  let rows = await page(cursor);
  if (!rows.length && cursor) rows = await page(undefined);
  const canonical = await canonicalTrailOwners(
    db,
    rows.map((row) => ({ threadId: row.thread_id, turnId: row.turn_id })),
  );
  const grouped = new Map<
    string,
    { owner: NormalizedTrail["owner"]; signals: Array<(typeof rows)[number]> }
  >();
  for (const [index, row] of rows.entries()) {
    const owner = canonical[index];
    const [existing] = await db
      .select({ id: changeTrailShells.id })
      .from(changeTrailShells)
      .where(
        and(
          eq(changeTrailShells.threadId, owner.threadId as ThreadId),
          owner.kind === "turn"
            ? eq(changeTrailShells.turnId, owner.turnId as TurnId)
            : eq(changeTrailShells.ownerKind, "shared"),
        ),
      );
    const id = existing?.id ?? trailIdForOwner(owner);
    const group = grouped.get(id) ?? { owner, signals: [] };
    group.signals.push(row);
    grouped.set(id, group);
  }
  const failures: unknown[] = [];
  for (const [id, group] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      await runInRootDrizzleTransaction(
        db,
        async () => {
          const tx = currentDrizzleDb(db);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
          const consumed = await tx.execute(sql`
          DELETE FROM change_trail_dirty_log signal WHERE ${sql.join(
            group.signals.map(
              (row) =>
                sql`(signal.thread_id = ${row.thread_id}::uuid AND signal.turn_id IS NOT DISTINCT FROM ${row.turn_id}::uuid)`,
            ),
            sql` OR `,
          )} RETURNING seq
        `);
          let [shell] = await tx
            .select()
            .from(changeTrailShells)
            .where(eq(changeTrailShells.id, id));
          if (consumed.length) {
            const projection = await project(group.owner);
            const incoming = projection.trails[0];
            const details = shell
              ? await tx
                  .select()
                  .from(changeTrailDocumentDetails)
                  .where(eq(changeTrailDocumentDetails.trailId, id))
              : [];
            const existingChanges = details.flatMap((detail) => detail.changes as TrailChangeV1[]);
            if (incoming.changes.length || existingChanges.length) {
              await writer.record(projection);
              [shell] = await tx
                .select()
                .from(changeTrailShells)
                .where(eq(changeTrailShells.id, id));
            }
          }
          if (!shell && group.owner.kind === "turn") {
            [shell] = await tx
              .insert(changeTrailShells)
              .values({
                id,
                threadId: group.owner.threadId as ThreadId,
                turnId: group.owner.turnId as TurnId,
                ownerKind: "turn",
                changeCount: 0,
                documentCount: 0,
              })
              .returning();
          }
          if (!shell) return;
          const readiness = await tx.execute<{ terminal: boolean }>(sql`
            SELECT CASE WHEN ${group.owner.turnId}::uuid IS NOT NULL THEN EXISTS (
              SELECT 1 FROM turns WHERE id = ${group.owner.turnId}::uuid AND status IN ('complete','cancelled','error')
            ) ELSE NOT EXISTS (
              SELECT 1 FROM turns WHERE thread_id = ${group.owner.threadId}::uuid AND status NOT IN ('complete','cancelled','error')
            ) END AS terminal
          `);
          const pending = await tx.execute<{ thread_id: string; turn_id: string | null }>(sql`
            SELECT DISTINCT affected.thread_id,affected.turn_id FROM draft_write_journal journal
            CROSS JOIN LATERAL change_trail_owners('{}', ARRAY[journal.id]) affected
            WHERE journal.status = 'rollback_pending'
          `);
          const pendingOwners = await canonicalTrailOwners(
            db,
            pending.map((row) => ({ threadId: row.thread_id, turnId: row.turn_id })),
          );
          const ready = !pendingOwners.some(
            (owner) => trailIdForOwner(owner) === trailIdForOwner(group.owner),
          );
          let state = shell.state;
          let version = shell.version;
          const transition = async (next: typeof state) => {
            state = next;
            version += 1;
            const settled = next === "settled";
            await tx
              .update(changeTrailShells)
              .set({
                state,
                version,
                settledAt: settled ? new Date() : null,
                updatedAt: new Date(),
              })
              .where(eq(changeTrailShells.id, id));
            const eventKind = settled ? ("settled" as const) : ("updated" as const);
            await tx
              .insert(changeTrailDeliveryOutbox)
              .values({
                eventId: deterministicUuid(`change-trail-event:${id}:${version}:${eventKind}`),
                threadId: shell.threadId,
                trailId: id,
                version,
                eventKind,
                changeCount: shell.changeCount,
                documentCount: shell.documentCount,
                ...(settled
                  ? {
                      documents: shell.documents,
                      wordsAdded: shell.wordsAdded,
                      wordsRemoved: shell.wordsRemoved,
                    }
                  : {}),
              })
              .onConflictDoNothing();
          };
          if (state === "settled" && consumed.length) await transition("building");
          if (!readiness[0].terminal) return;
          if (state === "building") await transition("settling");
          else if (state === "settling" && ready) await transition("settled");
        },
        { isolationLevel: "repeatable read" },
      );
    } catch (error) {
      failures.push(error);
    }
  }
  // Each owner has already been attempted; a corrupt history cannot starve its neighbors.
  const last = rows.at(-1);
  return {
    cursor: last ? { thread_id: last.thread_id, turn_key: last.turn_key } : undefined,
    failures,
  };
}
