/** Runtime-owned atomic response observation store and initial authority-prefix freezer. */

import type { ObservationSnapshot, ObservationSnapshotStore } from "@meridian/agent-edit";
import type {
  DocumentAuthorityId,
  DocumentId,
  ModelResponseId,
  ResponseCausalCutV1,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  modelResponseCausalCuts,
  modelResponseObservationEntries,
  modelResponseObservationSnapshots,
} from "@meridian/database";
import { asc, eq } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { DocumentAuthorityHeads } from "../../collab/index.js";

export function createDrizzleResponseObservations(
  db: Database,
  documentAuthorityHeads: DocumentAuthorityHeads,
): {
  store: ObservationSnapshotStore;
  freezeCausalCuts(documentIds: readonly string[]): Promise<ResponseCausalCutV1[]>;
} {
  const store: ObservationSnapshotStore = {
    async seal(snapshot) {
      await runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await tx.insert(modelResponseObservationSnapshots).values({
          responseId: snapshot.responseId as ModelResponseId,
        });
        if (snapshot.causalCuts && snapshot.causalCuts.length > 0) {
          await tx.insert(modelResponseCausalCuts).values(
            snapshot.causalCuts.map((cut) => ({
              id: cut.id,
              responseId: snapshot.responseId as ModelResponseId,
              documentId: cut.documentId as DocumentId,
              authorityId: cut.authorityId as DocumentId,
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
      const readDb = currentDrizzleDb(db);
      const [header] = await readDb
        .select({ responseId: modelResponseObservationSnapshots.responseId })
        .from(modelResponseObservationSnapshots)
        .where(eq(modelResponseObservationSnapshots.responseId, responseId as ModelResponseId))
        .limit(1);
      if (!header) return null;
      const [entries, cuts] = await Promise.all([
        readDb
          .select()
          .from(modelResponseObservationEntries)
          .where(eq(modelResponseObservationEntries.responseId, responseId as ModelResponseId))
          .orderBy(
            asc(modelResponseObservationEntries.documentId),
            asc(modelResponseObservationEntries.clientId),
            asc(modelResponseObservationEntries.clock),
          ),
        readDb
          .select()
          .from(modelResponseCausalCuts)
          .where(eq(modelResponseCausalCuts.responseId, responseId as ModelResponseId))
          .orderBy(asc(modelResponseCausalCuts.documentId)),
      ]);
      return {
        responseId,
        entries: entries.map((row) => ({
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

  return {
    store,
    async freezeCausalCuts(documentIds) {
      const uniqueIds = [...new Set(documentIds)].sort();
      if (uniqueIds.length === 0) return [];
      const heads = await documentAuthorityHeads.ensureAndReadAuthorityHeads(uniqueIds);
      return heads.map((head) => ({
        id: crypto.randomUUID(),
        version: 1,
        documentId: head.documentId,
        authorityId: head.authorityId,
        generation: head.generation,
        admittedThrough: head.admittedThrough,
      }));
    },
  };
}

function required(value: string | null, label: string): string {
  if (value === null) throw new Error(`Corrupt observation snapshot: missing ${label}`);
  return value;
}
