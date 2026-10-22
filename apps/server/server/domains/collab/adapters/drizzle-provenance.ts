/** Parses a checkpoint's stored attribution manifest into the provenance domain's shape. */

import type {
  AttributionManifestV1,
  AttributionRunV1,
  JournalReplayKey,
} from "../domain/provenance.js";
import { ProvenanceMaterializationError } from "../domain/provenance.js";

export function parseAttributionManifest(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
