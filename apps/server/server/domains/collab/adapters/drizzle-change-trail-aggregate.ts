/** Compatibility factory for the change-trail aggregate persistence port. */
import { createHash } from "node:crypto";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  changeTrailDeliveryOutbox,
  changeTrailDocumentDetails,
  changeTrailDocumentOccurrences,
  changeTrailShells,
} from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";

export type ChangeTrailAggregateWriter = ChangeTrailPersistence & {
  reopenOwners(owners: readonly NormalizedTrail["owner"][]): Promise<void>;
  reconcileTerminalOwners(): Promise<void>;
};

import {
  canonicalChangeKey,
  type NormalizedTrail,
  type TrailChangeV1,
} from "../domain/trail-read-kernel.js";

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

export function mergeTrailChanges(
  existing: readonly TrailChangeV1[],
  incoming: readonly TrailChangeV1[],
): TrailChangeV1[] {
  const folded = new Map<string, TrailChangeV1>();
  const ordered = [
    ...[...existing].sort((a, b) => a.ordinal - b.ordinal),
    ...[...incoming].sort((a, b) => a.ordinal - b.ordinal),
  ];
  for (const change of ordered) {
    const key = canonicalChangeKey(change);
    const prior = folded.get(key);
    if (!prior) {
      folded.set(key, change);
      continue;
    }
    const combined: TrailChangeV1 = {
      ...change,
      changeId: prior.changeId,
      beforeBlockId: prior.beforeBlockId,
      beforeText: prior.beforeText,
      kind:
        prior.beforeText === null
          ? "insert"
          : change.afterTextAtReceipt === null
            ? "delete"
            : "modify",
      swept: change.swept ?? prior.swept,
    };
    if (combined.beforeText === combined.afterTextAtReceipt) folded.delete(key);
    else folded.set(key, combined);
  }
  return [...folded.values()].map((change, ordinal) => ({ ...change, ordinal }));
}

export function createDrizzleChangeTrailAggregateWriter(db: Database): ChangeTrailAggregateWriter {
  return {
    async record(input) {
      const tx = currentDrizzleDb(db);
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
        if (input.refineCurrentVersion && !existingShell) {
          throw new Error(`Cannot refine missing change trail ${trailId}`);
        }
        const version = input.refineCurrentVersion
          ? (existingShell?.version as number)
          : (existingShell?.version ?? 0) + 1;
        if (!input.refineCurrentVersion) {
          await tx
            .insert(changeTrailShells)
            .values({
              id: trailId,
              threadId: trail.owner.threadId as ThreadId,
              turnId: trail.owner.kind === "turn" ? (trail.owner.turnId as TurnId) : null,
              ownerKind: trail.owner.kind,
              version,
              changeCount: trail.counts.changes,
              sweptChangeCount: trail.counts.swept,
              documentCount: trail.counts.documents,
            })
            .onConflictDoNothing();
        }

        const existingDetails = await tx
          .select({
            documentId: changeTrailDocumentDetails.documentId,
            changes: changeTrailDocumentDetails.changes,
          })
          .from(changeTrailDocumentDetails)
          .where(eq(changeTrailDocumentDetails.trailId, trailId));
        const incomingPushIds = new Set(trail.changes.map((change) => change.pushId));
        const persistedChanges = existingDetails.flatMap(
          (detail) => detail.changes as TrailChangeV1[],
        );
        const persistedPushChanges = persistedChanges.filter((change) =>
          incomingPushIds.has(change.pushId),
        );
        const incomingKeys = new Set(trail.changes.map(canonicalChangeKey));
        const refinementIsComplete =
          persistedPushChanges.length === incomingKeys.size &&
          persistedPushChanges.every((change) => incomingKeys.has(canonicalChangeKey(change)));
        const changes = input.refineCurrentVersion
          ? refinementIsComplete
            ? mergeTrailChanges(
                persistedChanges.filter((change) => !incomingPushIds.has(change.pushId)),
                trail.changes,
              )
            : persistedChanges
          : mergeTrailChanges(persistedChanges, trail.changes);
        const documentIds = new Set([
          ...existingDetails.map((detail) => detail.documentId),
          ...trail.changes.flatMap((change) => (change.documentId ? [change.documentId] : [])),
        ]);
        for (const documentId of documentIds) {
          await tx
            .insert(changeTrailDocumentOccurrences)
            .values({ trailId, documentId })
            .onConflictDoNothing();
          const documentChanges = changes.filter((change) => change.documentId === documentId);
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
          await tx
            .insert(changeTrailDocumentDetails)
            .values({
              trailId,
              documentId,
              documentTitle: input.documentTitles.get(documentId) ?? "Untitled document",
              changes: documentChanges,
            })
            .onConflictDoUpdate({
              target: [changeTrailDocumentDetails.trailId, changeTrailDocumentDetails.documentId],
              set: {
                documentTitle: input.documentTitles.get(documentId) ?? "Untitled document",
                changes: documentChanges,
                updatedAt: new Date(),
              },
            });
        }

        const details = await tx
          .select({ changes: changeTrailDocumentDetails.changes })
          .from(changeTrailDocumentDetails)
          .where(eq(changeTrailDocumentDetails.trailId, trailId));
        const allChanges = details.flatMap((detail) => detail.changes as TrailChangeV1[]);
        await tx
          .update(changeTrailShells)
          .set({
            version,
            state: "building",
            settledAt: null,
            changeCount: allChanges.length,
            sweptChangeCount: allChanges.filter((change) => change.swept !== null).length,
            documentCount: details.length,
            updatedAt: new Date(),
          })
          .where(eq(changeTrailShells.id, trailId));
        const counts = {
          changeCount: allChanges.length,
          sweptChangeCount: allChanges.filter((change) => change.swept !== null).length,
          documentCount: details.length,
        };
        if (input.refineCurrentVersion) {
          await tx
            .update(changeTrailDeliveryOutbox)
            .set(counts)
            .where(
              and(
                eq(changeTrailDeliveryOutbox.trailId, trailId),
                eq(changeTrailDeliveryOutbox.version, version),
                eq(changeTrailDeliveryOutbox.eventKind, "updated"),
              ),
            );
        } else {
          await tx.insert(changeTrailDeliveryOutbox).values({
            eventId: deterministicUuid(`change-trail-event:${trailId}:${version}:updated`),
            threadId: trail.owner.threadId as ThreadId,
            trailId,
            version,
            eventKind: "updated",
            ...counts,
          });
        }
      }
    },
    async reopenOwners(owners) {
      const tx = currentDrizzleDb(db);
      const sortedOwners = [
        ...new Map(owners.map((owner) => [trailIdForOwner(owner), owner])).entries(),
      ].sort(([left], [right]) => left.localeCompare(right));
      for (const [trailId] of sortedOwners) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trailId}))`);
      }
      for (const [trailId, owner] of sortedOwners) {
        const [reopened] = await tx
          .update(changeTrailShells)
          .set({
            state: "building",
            version: sql`${changeTrailShells.version} + 1`,
            settledAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(changeTrailShells.id, trailId), eq(changeTrailShells.state, "settled")))
          .returning({
            version: changeTrailShells.version,
            changeCount: changeTrailShells.changeCount,
            sweptChangeCount: changeTrailShells.sweptChangeCount,
            documentCount: changeTrailShells.documentCount,
          });
        if (!reopened) continue;
        await tx
          .insert(changeTrailDeliveryOutbox)
          .values({
            eventId: deterministicUuid(`change-trail-event:${trailId}:${reopened.version}:updated`),
            threadId: owner.threadId as ThreadId,
            trailId,
            version: reopened.version,
            eventKind: "updated",
            changeCount: reopened.changeCount,
            sweptChangeCount: reopened.sweptChangeCount,
            documentCount: reopened.documentCount,
          })
          .onConflictDoNothing();
      }
    },
    async reconcileTerminalOwners() {
      await reconcileTerminalOwners(db);
    },
  };
}

/** Advances turn trails only after the terminal turn policy has covered every owned row. */
async function reconcileTerminalOwners(db: Database): Promise<void> {
  await runInRootDrizzleTransaction(db, async () => {
    const tx = currentDrizzleDb(db);
    const owners = await tx.execute(sql`
      SELECT DISTINCT work.thread_id, work.turn_id
      FROM turn_trail_work work
      JOIN turns turn ON turn.id = work.turn_id
      WHERE turn.status IN ('complete', 'cancelled', 'error')
    `);
    const turnShells = (owners as unknown as Array<{ thread_id: string; turn_id: string }>).map(
      (owner) => ({
        ...owner,
        id: trailIdForOwner({
          kind: "turn",
          threadId: owner.thread_id,
          turnId: owner.turn_id,
        }),
      }),
    );
    const mutableShells = await tx.execute(sql`
      SELECT shell.id
      FROM change_trail_shells shell
      WHERE (shell.turn_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM turns turn
          WHERE turn.id = shell.turn_id AND turn.status IN ('complete', 'cancelled', 'error')
        )) OR (shell.owner_kind = 'shared' AND NOT EXISTS (
          SELECT 1 FROM turns turn
          WHERE turn.thread_id = shell.thread_id
            AND turn.status NOT IN ('complete', 'cancelled', 'error')
        ))
    `);
    const lockedTrailIds = new Set([
      ...turnShells.map((owner) => owner.id),
      ...(mutableShells as unknown as Array<{ id: string }>).map((shell) => shell.id),
    ]);
    for (const id of [...lockedTrailIds].sort()) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
    }
    for (const owner of turnShells) {
      await tx
        .insert(changeTrailShells)
        .values({
          id: owner.id,
          threadId: owner.thread_id as never,
          turnId: owner.turn_id as never,
          ownerKind: "turn",
          changeCount: 0,
          sweptChangeCount: 0,
          documentCount: 0,
        })
        .onConflictDoNothing();
    }
    const reopened = await tx.execute(sql`
      UPDATE change_trail_shells shell SET state = 'building', version = version + 1,
        settled_at = NULL, updated_at = now()
      WHERE shell.state = 'settled' AND EXISTS (
        SELECT 1 FROM turn_trail_work work
        WHERE work.thread_id = shell.thread_id
          AND (shell.owner_kind = 'shared' OR work.turn_id = shell.turn_id)
          AND work.updated_at > shell.settled_at
      )
      RETURNING shell.id, shell.thread_id, shell.version, shell.change_count,
        shell.swept_change_count, shell.document_count
    `);
    for (const item of reopened as unknown as Array<{
      id: string;
      thread_id: string;
      version: number;
      change_count: number;
      swept_change_count: number;
      document_count: number;
    }>) {
      await tx
        .insert(changeTrailDeliveryOutbox)
        .values({
          eventId: deterministicUuid(`change-trail-event:${item.id}:${item.version}:updated`),
          threadId: item.thread_id as never,
          trailId: item.id,
          version: item.version,
          eventKind: "updated",
          changeCount: item.change_count,
          sweptChangeCount: item.swept_change_count,
          documentCount: item.document_count,
        })
        .onConflictDoNothing();
    }
    // Settle only trails which entered `settling` in an earlier reconciliation.
    // This preserves a durable, observable settling version between RUN_FINISHED
    // and the terminal event instead of collapsing both states in one poll.
    const ready = await tx.execute(sql`
      SELECT shell.id, shell.version, shell.change_count, shell.swept_change_count,
        shell.document_count
      FROM change_trail_shells AS shell
      WHERE shell.state = 'settling'
        AND (
          (shell.turn_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM turn_trail_work work
            WHERE work.thread_id = shell.thread_id AND work.turn_id = shell.turn_id
              AND work.state NOT IN ('complete', 'no_op')
          ))
          OR (shell.owner_kind = 'shared' AND NOT EXISTS (
            SELECT 1 FROM turn_trail_work work
            JOIN turns turn ON turn.id = work.turn_id
            WHERE work.thread_id = shell.thread_id
              AND (work.state NOT IN ('complete', 'no_op') OR turn.status NOT IN ('complete', 'cancelled', 'error'))
          ))
        )
        AND NOT EXISTS (
          SELECT 1 FROM branch_write_journal AS journal
          WHERE journal.thread_id = shell.thread_id
            AND journal.turn_id = shell.turn_id
            AND journal.status IN ('active', 'rollback_pending')
            AND NOT EXISTS (SELECT 1 FROM turn_trail_work work WHERE work.journal_id = journal.id AND work.state = 'no_op')
        )
      FOR UPDATE SKIP LOCKED
    `);
    for (const item of ready as unknown as Array<{
      id: string;
      version: number;
      change_count: number;
      swept_change_count: number;
      document_count: number;
    }>) {
      const version = item.version + 1;
      await tx
        .update(changeTrailShells)
        .set({ state: "settled", version, settledAt: new Date(), updatedAt: new Date() })
        .where(and(eq(changeTrailShells.id, item.id), eq(changeTrailShells.state, "settling")));
      await tx
        .insert(changeTrailDeliveryOutbox)
        .values({
          eventId: deterministicUuid(`change-trail-event:${item.id}:${version}:settled`),
          threadId: sql`(SELECT thread_id FROM change_trail_shells WHERE id = ${item.id})`,
          trailId: item.id,
          version,
          eventKind: "settled",
        })
        .onConflictDoNothing();
    }

    const entering = await tx.execute(sql`
      UPDATE change_trail_shells AS shell
      SET state = 'settling', version = shell.version + 1, updated_at = now()
      FROM turns
      WHERE shell.turn_id = turns.id
        AND shell.state = 'building'
        AND turns.status IN ('complete', 'cancelled', 'error')
      RETURNING shell.id, shell.thread_id, shell.version, shell.change_count,
        shell.swept_change_count, shell.document_count
    `);

    await tx.execute(sql`
      UPDATE change_trail_shells shell SET state = 'settling', version = version + 1, updated_at = now()
      WHERE shell.owner_kind = 'shared' AND shell.state = 'building'
        AND NOT EXISTS (
          SELECT 1 FROM turns turn WHERE turn.thread_id = shell.thread_id
            AND turn.status NOT IN ('complete', 'cancelled', 'error')
        )
    `);
    for (const item of entering as unknown as Array<{
      id: string;
      thread_id: string;
      version: number;
      change_count: number;
      swept_change_count: number;
      document_count: number;
    }>) {
      await tx
        .insert(changeTrailDeliveryOutbox)
        .values({
          eventId: deterministicUuid(`change-trail-event:${item.id}:${item.version}:updated`),
          threadId: item.thread_id,
          trailId: item.id,
          version: item.version,
          eventKind: "updated",
          changeCount: item.change_count,
          sweptChangeCount: item.swept_change_count,
          documentCount: item.document_count,
        })
        .onConflictDoNothing();
    }
  });
}
