/** Restartable metadata import after the composition owner has acquired exclusive legacy handoff. */
import type {
  MigrationEvidence,
  NamespaceIntent,
  ResourceDescriptor,
  ResourceMetadataStore,
  ResourceRecord,
} from "@meridian/resource-replica";
import type { RoomOrderRecord } from "../editor/document-session-authority-store";
import {
  decodeLegacyResource,
  type LegacyResourceBytes,
  type LegacyResourceRecord,
} from "./legacy-resource-record";

/** Supplied by the existing account authority owner; never constructs another authority store. */
export interface LegacyResourceAuthority {
  readonly accountId: string;
  readRoom(documentId: string): Promise<RoomOrderRecord>;
}

function importedRecord(
  record: LegacyResourceRecord,
  room: RoomOrderRecord | null,
): ResourceRecord | null {
  const key = { projectId: record.ref.projectId, handle: record.ref.lineageHandle };
  if (record.kind === "terminal") {
    const authority = room?.persistence;
    if (
      !authority ||
      room?.pendingDrain ||
      authority.phase !== "terminal-local" ||
      authority.transitionId !== record.transitionId ||
      authority.lineageHandle !== record.ref.lineageHandle ||
      authority.exactDatabaseName !== record.exactDatabaseName ||
      authority.terminalGeneration !== record.terminalGeneration
    )
      return null;
    return {
      resource: {
        ...key,
        revision: 1,
        identity: { documentId: record.documentId, revision: 1 },
        content: { kind: "exact", databaseName: record.exactDatabaseName, schema: null },
        canonical: null,
        lifecycle: {
          kind: "terminal",
          generation: record.terminalGeneration,
          transitionId: record.transitionId,
        },
        aliases: {},
        obligations: {
          cleanup: {
            obligationId: record.cleanupObligationId,
            exactDatabaseName: record.exactDatabaseName,
          },
        },
      },
      intents: [],
    };
  }
  if (
    room?.pendingDrain ||
    room?.persistence?.phase === "terminal-local" ||
    room?.persistence?.phase === "adopting-local"
  )
    return null;
  const authority = room?.persistence;
  if (
    record.kind === "adopted" &&
    (authority?.phase !== "bindable" || authority.originLineageHandle !== record.ref.lineageHandle)
  )
    return null;
  if (
    record.kind === "local" &&
    authority &&
    (authority.originLineageHandle !== record.ref.lineageHandle ||
      authority.exactDatabaseName !== record.persistence.exactDatabaseName)
  )
    return null;
  const databaseName =
    record.kind === "local" ? record.persistence.exactDatabaseName : authority?.exactDatabaseName;
  if (!databaseName) return null;
  // Legacy settlements do not retain submitted request bytes or current canonical authority.
  // Keep them recoverable until the handoff resolver can establish their outcome.
  if (record.work.createSettlement.kind !== "ready") return null;
  if (
    record.kind === "adopted" &&
    ((record.canonicalSync &&
      (record.canonicalSync.documentId !== record.active.documentId ||
        record.canonicalSync.adoptionRevision !== record.adoptionRevision)) ||
      (record.publication &&
        (record.publication.documentId !== record.active.documentId ||
          record.publication.lineageHandle !== record.ref.lineageHandle ||
          record.publication.adoptionRevision !== record.adoptionRevision)))
  )
    return null;
  const resource: ResourceDescriptor = {
    ...key,
    revision: 1,
    identity: { documentId: record.active.documentId, revision: record.active.identityRevision },
    content: { kind: "exact", databaseName, schema: null },
    canonical: null,
    lifecycle:
      record.kind === "adopted"
        ? {
            kind: "acknowledged",
            availabilityGeneration: authority?.phase === "bindable" ? authority.generation : null,
          }
        : { kind: "local" },
    aliases: record.aliases,
    obligations:
      record.kind === "adopted"
        ? { canonicalSync: record.canonicalSync, publication: record.publication }
        : {},
  };
  const intents: NamespaceIntent[] = [];
  if (record.kind === "local" && (record.work.home || record.work.desiredIdentity)) {
    intents.push({
      ...key,
      intentId: `${key.handle}:import-create`,
      sequence: 1,
      identityRevision: record.active.identityRevision,
      desired: { kind: "create", folderPath: record.work.home?.folderPath ?? "" },
      attempts: [],
      state: "pending",
    });
  }
  if (record.work.desiredIdentity) {
    const desired = record.work.desiredIdentity;
    intents.push({
      ...key,
      intentId: `${key.handle}:import-location`,
      sequence: intents.length + 1,
      identityRevision: record.active.identityRevision,
      desired: {
        kind: "set-location",
        destination: {
          scheme: desired.destination.scheme,
          folderPath: desired.destination.folderPath,
          name: desired.name,
          workId: desired.destination.workId ?? null,
        },
      },
      attempts: [],
      state: record.work.failure ? "needs-repair" : "pending",
    });
  }
  return { resource, intents };
}

/** Handoff stays held by the caller across the snapshot, this import and new-owner activation. */
export async function importLegacyResources(input: {
  accountId: string;
  source: readonly LegacyResourceBytes[];
  authority: LegacyResourceAuthority;
  metadata: ResourceMetadataStore;
}): Promise<"complete" | "recovery-required"> {
  if (input.accountId !== input.authority.accountId || input.accountId !== input.metadata.accountId)
    throw new Error("Legacy import account mismatch");
  const sources = input.source.map((source) => ({ ...source }));
  let progress = await input.metadata.readMigration();
  if (progress.checkpoint?.state === "complete") return "complete";
  for (const source of sources) {
    const previous = progress.evidence.find((item) => item.sourceKey === source.sourceKey);
    if (previous) {
      if (previous.raw !== source.raw) throw new Error("Legacy source changed after handoff");
      if (previous.status === "imported") continue;
    }
    const legacy = decodeLegacyResource(input.accountId, source);
    const documentId = legacy?.kind === "terminal" ? legacy.documentId : legacy?.active.documentId;
    const room = documentId ? await input.authority.readRoom(documentId) : null;
    const imported = legacy ? importedRecord(legacy, room) : null;
    const evidence: MigrationEvidence = {
      ...source,
      status: imported ? "imported" : "recovery",
      ...(imported
        ? {}
        : {
            reason: legacy
              ? "Unresolved legacy authority or obligations"
              : "Unsupported or malformed legacy record",
          }),
    };
    const expectedRevision = progress.checkpoint?.revision ?? null;
    const result = await input.metadata.commitMigration({
      expectedRevision,
      next: { revision: (expectedRevision ?? 0) + 1, state: "importing" },
      evidence: [evidence],
      resources: imported ? [{ expectedRevision: null, next: imported }] : [],
    });
    if (result === "stale") throw new Error("Legacy migration ownership changed");
    progress = await input.metadata.readMigration();
  }
  if (progress.evidence.some((item) => item.status === "recovery")) return "recovery-required";
  const expectedRevision = progress.checkpoint?.revision ?? null;
  const result = await input.metadata.commitMigration({
    expectedRevision,
    next: { revision: (expectedRevision ?? 0) + 1, state: "complete" },
    evidence: [],
    resources: [],
  });
  if (result === "stale") throw new Error("Legacy migration ownership changed");
  return "complete";
}
