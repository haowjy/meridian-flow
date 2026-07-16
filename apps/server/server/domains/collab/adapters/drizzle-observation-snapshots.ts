/** Postgres adapter for immutable response observation snapshots. */

import type { ObservationSnapshot, ObservationSnapshotStore } from "@meridian/agent-edit";
import type { DocumentAuthorityId, DocumentId, ModelResponseId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  modelResponseCausalCuts,
  modelResponseObservationEntries,
  modelResponseObservationSnapshots,
} from "@meridian/database";
import { asc, eq } from "drizzle-orm";

type ObservationDb = Pick<Database, "insert" | "select" | "transaction">;

export function createDrizzleObservationSnapshotStore(db: ObservationDb): ObservationSnapshotStore {
  return {
    async seal(snapshot) {
      await db.transaction(async (tx) => {
        await tx.insert(modelResponseObservationSnapshots).values({
          responseId: snapshot.responseId as ModelResponseId,
        });
        if (snapshot.causalCuts?.length) {
          await tx.insert(modelResponseCausalCuts).values(
            snapshot.causalCuts.map((cut) => ({
              id: cut.id,
              responseId: snapshot.responseId as ModelResponseId,
              documentId: cut.documentId as DocumentId,
              authorityId: cut.authorityId as DocumentAuthorityId,
              generation: cut.generation,
              admittedThrough: cut.admittedThrough,
            })),
          );
        }
        if (snapshot.entries.length > 0) {
          await tx.insert(modelResponseObservationEntries).values(
            snapshot.entries.map((entry) => ({
              responseId: snapshot.responseId as ModelResponseId,
              documentId: entry.documentId as DocumentId,
              clientId: entry.clientID,
              clock: entry.clock,
              kind: entry.value.kind,
              contentDigest: entry.value.kind === "rendered" ? entry.value.digest : null,
              capturedDeletedBody:
                entry.value.kind === "explicit_deletion" ? entry.value.capturedBody : null,
            })),
          );
        }
      });
    },

    async load(responseId): Promise<ObservationSnapshot | null> {
      const [header] = await db
        .select({ responseId: modelResponseObservationSnapshots.responseId })
        .from(modelResponseObservationSnapshots)
        .where(eq(modelResponseObservationSnapshots.responseId, responseId as ModelResponseId))
        .limit(1);
      if (!header) return null;

      const [rows, cuts] = await Promise.all([
        db
          .select()
          .from(modelResponseObservationEntries)
          .where(eq(modelResponseObservationEntries.responseId, responseId as ModelResponseId))
          .orderBy(
            asc(modelResponseObservationEntries.documentId),
            asc(modelResponseObservationEntries.clientId),
            asc(modelResponseObservationEntries.clock),
          ),
        db
          .select()
          .from(modelResponseCausalCuts)
          .where(eq(modelResponseCausalCuts.responseId, responseId as ModelResponseId))
          .orderBy(asc(modelResponseCausalCuts.documentId)),
      ]);
      return {
        responseId,
        entries: rows.map((row) => ({
          documentId: row.documentId,
          clientID: row.clientId,
          clock: row.clock,
          value:
            row.kind === "rendered"
              ? { kind: "rendered", digest: required(row.contentDigest, "content digest") }
              : {
                  kind: "explicit_deletion",
                  capturedBody: required(row.capturedDeletedBody, "captured deleted body"),
                },
        })),
        causalCuts: cuts.map((cut) => ({
          id: cut.id,
          version: 1,
          documentId: cut.documentId,
          authorityId: cut.authorityId as DocumentAuthorityId,
          generation: cut.generation,
          admittedThrough: cut.admittedThrough,
        })),
      };
    },
  };
}

function required(value: string | null, label: string): string {
  if (value === null) throw new Error(`Corrupt observation snapshot: missing ${label}`);
  return value;
}
