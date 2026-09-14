/** Restartable metadata import after the composition owner has acquired exclusive legacy handoff. */
import type {
  MigrationEvidence,
  NamespaceIntent,
  ResourceDescriptor,
  ResourceMetadataStore,
  ResourceRecord,
} from "@meridian/resource-replica";
import type { ResourceAuthorityInspection } from "../editor/account-document-session-runtime";
import type { ResourceAuthoritySnapshot } from "../editor/document-session-authority-store";
import {
  decodeLegacyResource,
  type LegacyResourceBytes,
  type LegacyResourceRecord,
} from "./legacy-resource-record";

function importedRecord(
  record: LegacyResourceRecord,
  snapshot: ResourceAuthoritySnapshot | null,
  sourceKey: string,
): ResourceRecord | null {
  const room = snapshot?.room;
  const purge = snapshot?.pendingPurge;
  const key = { projectId: record.ref.projectId, handle: record.ref.lineageHandle };
  if (record.kind === "terminal") {
    const authority = room?.persistence;
    const cleared = !authority && !room?.pendingDrain && !purge;
    const pending =
      !room?.pendingDrain &&
      authority?.phase === "terminal-local" &&
      authority.transitionId === record.transitionId &&
      authority.lineageHandle === record.ref.lineageHandle &&
      authority.exactDatabaseName === record.exactDatabaseName &&
      authority.terminalGeneration === record.terminalGeneration &&
      purge?.accountId === record.ref.accountId &&
      purge.documentId === record.documentId &&
      purge.transitionId === record.transitionId &&
      purge.exactDatabaseName === record.exactDatabaseName &&
      purge.revokedThrough === record.terminalGeneration;
    if (!cleared && !pending) return null;
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
        obligations: pending
          ? {
              cleanup: {
                obligationId: record.cleanupObligationId,
                exactDatabaseName: record.exactDatabaseName,
              },
            }
          : {},
      },
      intents: [],
    };
  }
  if (
    purge ||
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
  const uncertain =
    record.work.createSettlement.kind !== "ready" ||
    (record.kind === "local" && authority?.phase === "bindable");
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
    ...(uncertain ? { recovery: { sourceKey } } : {}),
    aliases: record.aliases,
    obligations:
      record.kind === "adopted"
        ? { canonicalSync: record.canonicalSync, publication: record.publication }
        : {},
  };
  return { resource, intents: importedIntentions(record) };
}

function importedIntentions(
  record: Exclude<LegacyResourceRecord, { kind: "terminal" }>,
): NamespaceIntent[] {
  const key = { projectId: record.ref.projectId, handle: record.ref.lineageHandle };
  const intents: NamespaceIntent[] = [];
  if (
    record.kind === "local" &&
    record.work.createSettlement.kind === "ready" &&
    (record.work.home || record.work.desiredIdentity)
  ) {
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
  return intents;
}

/** Preserve discoverability without granting content, namespace or cleanup authority. */
function recoveryRecord(record: LegacyResourceRecord, sourceKey: string): ResourceRecord {
  return {
    resource: {
      projectId: record.ref.projectId,
      handle: record.ref.lineageHandle,
      revision: 1,
      identity:
        record.kind === "terminal"
          ? { documentId: record.documentId, revision: 1 }
          : { documentId: record.active.documentId, revision: record.active.identityRevision },
      content: { kind: "unacquired" },
      recovery: { sourceKey },
      canonical: null,
      lifecycle:
        record.kind === "terminal"
          ? {
              kind: "terminal",
              generation: record.terminalGeneration,
              transitionId: record.transitionId,
            }
          : { kind: "recovering" },
      aliases: record.kind === "terminal" ? {} : record.aliases,
      obligations: {},
    },
    intents: record.kind === "terminal" ? [] : importedIntentions(record),
  };
}

/** Handoff stays held by the caller across the snapshot, this import and new-owner activation. */
export async function importLegacyResources(input: {
  accountId: string;
  source: readonly LegacyResourceBytes[];
  authority: ResourceAuthorityInspection;
  metadata: ResourceMetadataStore;
}): Promise<"complete" | "recovery-required"> {
  if (input.accountId !== input.authority.accountId || input.accountId !== input.metadata.accountId)
    throw new Error("Legacy import account mismatch");
  const sources = input.source.map((source) => ({ ...source }));
  let progress = await input.metadata.readMigration();
  if (progress.checkpoint?.state === "complete")
    return progress.evidence.some((item) => item.status === "recovery")
      ? "recovery-required"
      : "complete";
  for (const source of sources) {
    const previous = progress.evidence.find((item) => item.sourceKey === source.sourceKey);
    if (previous) {
      if (previous.raw !== source.raw) throw new Error("Legacy source changed after handoff");
      continue;
    }
    const legacy = decodeLegacyResource(input.accountId, source);
    const documentId = legacy?.kind === "terminal" ? legacy.documentId : legacy?.active.documentId;
    const snapshot = documentId ? await input.authority.readSnapshot(documentId) : null;
    const imported = legacy ? importedRecord(legacy, snapshot, source.sourceKey) : null;
    const evidence: MigrationEvidence = {
      ...source,
      status: imported && !imported.resource.recovery ? "imported" : "recovery",
      ...(imported && !imported.resource.recovery
        ? {}
        : {
            reason: legacy
              ? "Unresolved legacy authority or obligations"
              : "Unsupported or malformed legacy record",
          }),
    };
    const resource = imported ?? (legacy ? recoveryRecord(legacy, source.sourceKey) : null);
    const expectedRevision = progress.checkpoint?.revision ?? null;
    const result = await input.metadata.commitMigration({
      expectedRevision,
      next: { revision: (expectedRevision ?? 0) + 1, state: "importing" },
      evidence: [evidence],
      resources: resource ? [{ expectedRevision: null, next: resource }] : [],
    });
    if (result === "stale") throw new Error("Legacy migration ownership changed");
    progress = await input.metadata.readMigration();
  }
  const expectedRevision = progress.checkpoint?.revision ?? null;
  const result = await input.metadata.commitMigration({
    expectedRevision,
    next: { revision: (expectedRevision ?? 0) + 1, state: "complete" },
    evidence: [],
    resources: [],
  });
  if (result === "stale") throw new Error("Legacy migration ownership changed");
  return progress.evidence.some((item) => item.status === "recovery")
    ? "recovery-required"
    : "complete";
}

/** Resolve captured records independently; unresolved resources do not reopen the capture checkpoint. */
export async function resolveLegacyResources(input: {
  accountId: string;
  authority: ResourceAuthorityInspection;
  metadata: ResourceMetadataStore;
}): Promise<void> {
  if (input.accountId !== input.authority.accountId || input.accountId !== input.metadata.accountId)
    throw new Error("Legacy import account mismatch");
  const progress = await input.metadata.readMigration();
  if (progress.checkpoint?.state !== "complete") throw new Error("Legacy capture is incomplete");
  for (const evidence of progress.evidence) {
    if (evidence.status !== "recovery") continue;
    const legacy = decodeLegacyResource(input.accountId, evidence);
    if (!legacy) continue;
    const documentId = legacy.kind === "terminal" ? legacy.documentId : legacy.active.documentId;
    const current = await input.metadata.readResource({
      projectId: legacy.ref.projectId,
      handle: legacy.ref.lineageHandle,
    });
    if (
      current?.resource.recovery?.sourceKey !== evidence.sourceKey ||
      (legacy.kind === "terminal"
        ? current.resource.lifecycle.kind !== "terminal" ||
          current.resource.lifecycle.generation !== legacy.terminalGeneration ||
          current.resource.lifecycle.transitionId !== legacy.transitionId
        : current.resource.lifecycle.kind !== "recovering")
    )
      continue;
    const imported = importedRecord(
      legacy,
      await input.authority.readSnapshot(documentId),
      evidence.sourceKey,
    );
    if (!imported || imported.resource.recovery) continue;
    if (
      current.resource.identity.documentId !== imported.resource.identity.documentId ||
      current.resource.identity.revision !== imported.resource.identity.revision ||
      (current.resource.content.kind === "exact" &&
        (imported.resource.content.kind !== "exact" ||
          current.resource.content.databaseName !== imported.resource.content.databaseName))
    )
      continue;
    // The capture installed legacy intentions before new writer intentions. Preserve their history.
    imported.intents = current.intents;
    imported.resource.revision = current.resource.revision + 1;
    imported.resource.canonical = current.resource.canonical;
    imported.resource.aliases = current.resource.aliases;
    if (current.resource.content.kind === "exact")
      imported.resource.content = current.resource.content;
    // A competing command may have changed this resource after the authority lookup.
    await input.metadata.resolveMigrationEvidence({
      sourceKey: evidence.sourceKey,
      expectedRaw: evidence.raw,
      resource: { expectedRevision: current.resource.revision, next: imported },
    });
  }
}
