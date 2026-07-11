/** Atomic persistence for thread-owned change-trail shells, protected detail, and delivery. */
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
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { NormalizedTrail, TrailChangeV1 } from "../domain/trail-read-kernel.js";

export type ChangeTrailPersistence = {
  record(input: {
    trails: readonly NormalizedTrail[];
    documentTitles: ReadonlyMap<string, string>;
  }): Promise<void>;
};

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
    const key = `${change.documentId ?? "deleted"}:${change.beforeBlockId ?? change.afterBlockId ?? change.changeId}`;
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
      swept: prior.swept ?? change.swept,
    };
    if (combined.beforeText === combined.afterTextAtReceipt) folded.delete(key);
    else folded.set(key, combined);
  }
  return [...folded.values()].map((change, ordinal) => ({ ...change, ordinal }));
}

export function createDrizzleChangeTrailPersistence(db: Database): ChangeTrailPersistence {
  return {
    async record(input) {
      const tx = currentDrizzleDb(db);
      for (const trail of input.trails) {
        const trailId = trailIdForOwner(trail.owner);
        // A response may push several documents concurrently. Serialize only the
        // trail aggregate; document and thread locks remain outside this path.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trailId}))`);
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
            sweptChangeCount: trail.counts.swept,
            documentCount: trail.counts.documents,
          })
          .onConflictDoNothing();

        const existingDetails = await tx
          .select({
            documentId: changeTrailDocumentDetails.documentId,
            changes: changeTrailDocumentDetails.changes,
          })
          .from(changeTrailDocumentDetails)
          .where(eq(changeTrailDocumentDetails.trailId, trailId));
        const changes = mergeTrailChanges(
          existingDetails.flatMap((detail) => detail.changes as TrailChangeV1[]),
          trail.changes,
        );
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
        await tx.insert(changeTrailDeliveryOutbox).values({
          eventId: deterministicUuid(`change-trail-event:${trailId}:${version}:updated`),
          threadId: trail.owner.threadId as ThreadId,
          trailId,
          version,
          eventKind: "updated",
        });
      }
    },
  };
}
