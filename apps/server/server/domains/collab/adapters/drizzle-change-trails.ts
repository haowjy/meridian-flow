/** Atomic persistence for thread-owned change-trail shells, protected detail, and delivery. */
import { createHash } from "node:crypto";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  changeTrailDeliveryOutbox,
  changeTrailDocumentDetails,
  changeTrailShells,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
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

function mergeChanges(existing: readonly TrailChangeV1[], incoming: readonly TrailChangeV1[]) {
  const changes = new Map<string, TrailChangeV1>();
  for (const change of [...existing, ...incoming]) {
    const key = `${change.documentId ?? "deleted"}:${change.beforeBlockId ?? change.afterBlockId ?? change.changeId}`;
    const prior = changes.get(key);
    changes.set(
      key,
      prior ? { ...change, changeId: prior.changeId, beforeText: prior.beforeText } : change,
    );
  }
  return [...changes.values()].map((change, ordinal) => ({ ...change, ordinal }));
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

        for (const documentId of new Set(
          trail.changes.flatMap((change) => (change.documentId ? [change.documentId] : [])),
        )) {
          const incoming = trail.changes.filter((change) => change.documentId === documentId);
          const [existing] = await tx
            .select({ changes: changeTrailDocumentDetails.changes })
            .from(changeTrailDocumentDetails)
            .where(
              sql`${changeTrailDocumentDetails.trailId} = ${trailId} AND ${changeTrailDocumentDetails.documentId} = ${documentId}`,
            )
            .limit(1);
          const changes = mergeChanges((existing?.changes ?? []) as TrailChangeV1[], incoming);
          await tx
            .insert(changeTrailDocumentDetails)
            .values({
              trailId,
              documentId,
              documentTitle: input.documentTitles.get(documentId) ?? "Untitled document",
              changes,
            })
            .onConflictDoUpdate({
              target: [changeTrailDocumentDetails.trailId, changeTrailDocumentDetails.documentId],
              set: {
                documentTitle: input.documentTitles.get(documentId) ?? "Untitled document",
                changes,
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
