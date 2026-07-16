/** Loads one authority generation and delegates warm/cold replay to the provenance materializer. */

import type { DocumentAuthorityId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentYjsCheckpoints, documentYjsUpdates } from "@meridian/database";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type {
  AttributionManifestV1,
  AttributionRunV1,
  JournalReplayKey,
  ProvenanceMaterialization,
} from "../domain/provenance.js";
import { materializeProvenanceView, ProvenanceMaterializationError } from "../domain/provenance.js";

type ProvenanceDb = Pick<Database, "select">;

export type ProvenanceReader = {
  materialize(input: {
    documentId: DocumentId;
    authorityId: DocumentAuthorityId;
    generation: bigint;
    watermark: JournalReplayKey;
  }): Promise<ProvenanceMaterialization>;
};

export function createDrizzleProvenanceReader(db: ProvenanceDb): ProvenanceReader {
  return {
    async materialize(input) {
      const watermarkRowId = safeDatabaseId(input.watermark.journalRowId);
      const [checkpoint] = await db
        .select()
        .from(documentYjsCheckpoints)
        .where(
          and(
            eq(documentYjsCheckpoints.documentId, input.documentId),
            eq(documentYjsCheckpoints.authorityId, input.authorityId),
            eq(documentYjsCheckpoints.authorityGeneration, input.generation),
            lte(documentYjsCheckpoints.upToSeq, watermarkRowId),
          ),
        )
        .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
        .limit(1);
      const afterRowId = checkpoint?.upToSeq ?? 0;
      const rows = await db
        .select()
        .from(documentYjsUpdates)
        .where(
          and(
            eq(documentYjsUpdates.documentId, input.documentId),
            eq(documentYjsUpdates.authorityId, input.authorityId),
            eq(documentYjsUpdates.authorityGeneration, input.generation),
            gt(documentYjsUpdates.id, afterRowId),
            lte(documentYjsUpdates.id, watermarkRowId),
          ),
        )
        .orderBy(
          asc(documentYjsUpdates.admissionSequence),
          asc(documentYjsUpdates.batchOrdinal),
          asc(documentYjsUpdates.id),
        );
      const manifest = checkpoint
        ? parseManifest(checkpoint.attributionManifest, {
            authorityId: input.authorityId,
            generation: input.generation,
            checkpointId: String(checkpoint.id),
          })
        : ({
            version: 1,
            authorityId: input.authorityId,
            generation: input.generation,
            checkpointId: "authority-origin",
            floor: null,
            attributions: [],
          } satisfies AttributionManifestV1);
      return materializeProvenanceView({
        authorityId: input.authorityId,
        generation: input.generation,
        ...(checkpoint ? { checkpointUpdate: new Uint8Array(checkpoint.state) } : {}),
        manifest,
        rows: rows.map((row) => ({
          authorityId: row.authorityId,
          generation: row.authorityGeneration,
          admissionSequence: row.admissionSequence,
          batchOrdinal: row.batchOrdinal,
          journalRowId: BigInt(row.id),
          originType: row.originType,
          actorUserId: row.actorUserId,
          update: new Uint8Array(row.updateData),
        })),
        watermark: input.watermark,
      });
    },
  };
}

function parseManifest(
  value: unknown,
  identity: Pick<AttributionManifestV1, "authorityId" | "generation" | "checkpointId">,
): AttributionManifestV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.attributions)) {
    throw new ProvenanceMaterializationError("Checkpoint attribution manifest is unavailable");
  }
  return {
    version: 1,
    ...identity,
    floor: value.floor === null ? null : parseReplayKey(value.floor),
    attributions: value.attributions.map(parseAttribution),
  };
}

function parseAttribution(value: unknown): AttributionRunV1 {
  if (!isRecord(value) || !isRecord(value.range)) {
    throw new ProvenanceMaterializationError("Invalid checkpoint insertion attribution");
  }
  const clientID = Number(value.range.clientID);
  const clock = Number(value.range.clock);
  const length = Number(value.range.length);
  if (
    !Number.isSafeInteger(clientID) ||
    !Number.isSafeInteger(clock) ||
    !Number.isSafeInteger(length) ||
    clientID < 0 ||
    clock < 0 ||
    length <= 0 ||
    !Number.isSafeInteger(clock + length) ||
    (value.birthClass !== "writer_protected" && value.birthClass !== "agent")
  ) {
    throw new ProvenanceMaterializationError("Invalid checkpoint insertion attribution");
  }
  return {
    range: { clientID, clock, length },
    birthClass: value.birthClass,
    origin: parseReplayKey(value.origin),
  };
}

function parseReplayKey(value: unknown): JournalReplayKey {
  if (!isRecord(value)) throw new ProvenanceMaterializationError("Invalid journal replay key");
  const admissionSequence = parseUnsignedBigint(value.admissionSequence);
  const journalRowId = parseUnsignedBigint(value.journalRowId);
  if (!Number.isSafeInteger(value.batchOrdinal) || Number(value.batchOrdinal) < 0) {
    throw new ProvenanceMaterializationError("Invalid journal batch ordinal");
  }
  return { admissionSequence, batchOrdinal: Number(value.batchOrdinal), journalRowId };
}

function parseUnsignedBigint(value: unknown): bigint {
  if ((typeof value !== "string" && typeof value !== "bigint") || !/^\d+$/.test(String(value))) {
    throw new ProvenanceMaterializationError("Invalid unsigned journal identity");
  }
  return BigInt(value);
}

function safeDatabaseId(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ProvenanceMaterializationError("Journal row identity exceeds database safe bounds");
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
